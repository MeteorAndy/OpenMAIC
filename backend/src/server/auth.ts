/**
 * Backend auth: stateless Supabase JWT validation.
 *
 * The browser Supabase client owns the session; the frontend sends its
 * access_token as `Authorization: Bearer <jwt>`. Self-hosted + cloud GoTrue
 * issue **ES256** user JWTs (derived from the EC keypair baked off JWT_SECRET)
 * and publish the public key at /auth/v1/.well-known/jwks.json, so we verify
 * ES256 via the JWKS (jose createRemoteJWKSet caches + refreshes on kid miss).
 * userId = payload.sub.
 *
 * userId is exposed two ways so existing lib code works unchanged:
 *   - Hono context variable (requireUser(c))
 *   - AsyncLocalStorage (getRequestUser()) — read by the session shim that
 *     lib/server/quota.ts reaches via getCurrentSession().
 *
 * RLS is preserved by a per-request Supabase client that impersonates the user
 * (src/server/supabase-server.ts), but the Phase-1 routes (health/quota/chat)
 * only touch the Drizzle admin connection, so that client is rarely exercised.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { runRequestUser, getRequestUser as getSharedRequestUser } from '@/lib/server/request-als';

export interface RequestUser {
  userId: string;
  token: string;
}

// ponytail: the per-request store lives in the SHARED lib/server/request-als.ts
// so lib/server/session.ts (which Next AND the backend both load) reads the very
// same AsyncLocalStorage the middleware populates — no build-time shim required.
// The local userStore below is retained only for requireUser(c) callers that
// import getRequestUser from this module; both read identical state because the
// middleware now runs the request inside the shared store.
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
 * Hono middleware: extract Bearer, verify ES256 via GoTrue's JWKS, set userId on
 * the context + AsyncLocalStorage for the request. Protected routes only.
 */
export const authMiddleware = createMiddleware<AuthVars>(async (c, next) => {
  const auth = c.req.header('authorization') || c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return unauthorized('Missing Bearer token');

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
