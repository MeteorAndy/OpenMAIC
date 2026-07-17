/**
 * Backend auth: stateless Supabase JWT validation.
 *
 * Accepts the token two ways:
 *  - Authorization: Bearer <jwt>  (direct API clients)
 *  - Supabase session cookie sb-<ref>-auth-token (browser via the Next proxy,
 *    which forwards cookies same-origin). @supabase/ssr writes the value as
 *    "base64-<base64url of the session JSON>"; we decode -> access_token.
 *
 * Self-hosted + cloud GoTrue issue ES256 user JWTs and publish the public key
 * at /auth/v1/.well-known/jwks.json, so we verify ES256 via the JWKS (jose
 * createRemoteJWKSet caches + refreshes on kid miss). userId = payload.sub.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { runRequestUser, getRequestUser as getSharedRequestUser } from '@/lib/server/request-als';

export interface RequestUser {
  userId: string;
  token: string;
}

const userStore = new AsyncLocalStorage<RequestUser>();

/** Read the per-request user from anywhere (quota.ts / session shim). */
export function getRequestUser(): RequestUser | null {
  return getSharedRequestUser() ?? userStore.getStore() ?? null;
}

export interface AuthVars {
  Variables: {
    userId: string;
    token: string;
  };
}

// JWKS keyset (lazy singleton). createRemoteJWKSet caches the keys and re-fetches
// when a token's kid is unknown (GoTrue rotates).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

function unauthorized(message: string) {
  return Response.json(
    { success: false, errorCode: 'UNAUTHENTICATED', error: message },
    { status: 401 },
  );
}

/**
 * Extract the Supabase access_token from the session cookie the browser client
 * writes (sb-<ref>-auth-token = "base64-<base64url session JSON>"). Handles the
 * common single-cookie case; chunked sessions (.0/.1) are a rare follow-up.
 */
function extractTokenFromCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (/^sb-.+-auth-token$/.test(name) && value.startsWith('base64-')) {
      try {
        const session = JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8'));
        if (typeof session.access_token === 'string') return session.access_token;
      } catch {
        /* malformed cookie part — keep scanning */
      }
    }
  }
  return null;
}

/**
 * Hono middleware: resolve the token from the Bearer header OR the Supabase
 * session cookie, verify ES256 via GoTrue's JWKS, set userId on the context +
 * AsyncLocalStorage. Protected routes only.
 */
export const authMiddleware = createMiddleware<AuthVars>(async (c, next) => {
  const auth = c.req.header('authorization') || c.req.header('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    const fromCookie = extractTokenFromCookie(c.req.header('cookie'));
    if (fromCookie) token = fromCookie;
  }
  if (!token) return unauthorized('Missing Bearer token or session cookie');

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.error('[auth] NEXT_PUBLIC_SUPABASE_URL is not set — cannot verify tokens');
    return unauthorized('Server auth not configured');
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      algorithms: ['ES256'],
    });
    const userId = payload.sub;
    if (!userId) return unauthorized('Token has no subject');
    c.set('userId', userId);
    c.set('token', token);
    return await runRequestUser({ userId, token }, () => next());
  } catch {
    return unauthorized('Invalid or expired token');
  }
});

/** Mirrors lib/server/session requireUserId — returns userId or throws. */
export function requireUser<Vars extends { userId: string }>(c: { get: (k: 'userId') => string }): string {
  const userId = c.get('userId');
  if (!userId) throw new Error('[auth] requireUser called outside an authenticated route');
  return userId;
}
