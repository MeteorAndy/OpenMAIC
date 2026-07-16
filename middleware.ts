import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Auth gate (SaaS, feat/saas).
 * Primary: better-auth session cookie (presence check only — no DB hit, edge-safe;
 * full validation happens in route handlers via auth.api.getSession).
 * Fallback: optional shared ACCESS_CODE (HMAC cookie) for local/dev only.
 */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyAccessCookie(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;
  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  const key = await crypto.subtle.importKey(
    'raw',
    encode(accessCode).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = bufToHex(
    await crypto.subtle.sign('HMAC', key, encode(timestamp).buffer as ArrayBuffer),
  );
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function isPublic(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/access-code/') ||
    pathname === '/api/health'
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  // 1. better-auth session cookie present?
  try {
    if (getSessionCookie(request)) return NextResponse.next();
  } catch {
    // getSessionCookie throws if AUTH_SECRET is unset; fall through to other gates.
  }

  // 2. Optional ACCESS_CODE dev fallback.
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode) {
    const cookie = request.cookies.get('openmaic_access');
    if (cookie?.value && (await verifyAccessCookie(cookie.value, accessCode))) {
      return NextResponse.next();
    }
  }

  // 3. Gate: API → 401 JSON; pages → redirect to /login.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'UNAUTHENTICATED', error: 'Sign in required' },
      { status: 401 },
    );
  }
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirect', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
