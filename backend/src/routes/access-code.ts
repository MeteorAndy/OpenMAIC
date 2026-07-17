/**
 * /api/access-code/{status,verify} — mirror app/api/access-code/{status,verify}/route.ts.
 *
 * NON-MECHANISTIC: the Next routes use next/headers cookies() to read/set the
 * `openmaic_access` cookie. The compiled backend is Bearer-auth + credentials-free
 * (per index.ts CORS), so next/headers is shimmed to throw. We instead read the
 * cookie from the raw `Cookie` request header and write it back via a `Set-Cookie`
 * response header. The access-code gate is a deployment-wide shared password
 * (distinct from per-user Supabase JWT auth); these routes stay PUBLIC.
 *
 * Caveat: Set-Cookie only takes effect same-origin (frontend proxied to the
 * backend, or same origin via next.config rewrite). Cross-origin + credentials-free
 * callers (the SaaS browser client) cannot rely on this cookie — the frontend
 * should treat `authenticated` as informational there.
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createAccessToken, verifyAccessToken } from '@/lib/server/access-token';

/** Read one cookie value from a raw Cookie header. */
function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export const accessCodeStatusRoute = new Hono();

accessCodeStatusRoute.get('/', async (c) => {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const token = readCookie(c.req.raw.headers.get('cookie'), 'openmaic_access');
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({ enabled, authenticated });
});

export const accessCodeVerifyRoute = new Hono();

accessCodeVerifyRoute.post('/', async (c) => {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }

  let body: { code?: string };
  try {
    body = await c.req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  if (!body.code) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(body.code);
  const b = encoder.encode(accessCode);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  const token = createAccessToken(accessCode);
  const maxAge = 60 * 60 * 24 * 7; // 7 days
  const cookie = [
    `openmaic_access=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ success: true, valid: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
});
