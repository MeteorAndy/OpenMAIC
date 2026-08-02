import { NextRequest, NextResponse } from 'next/server';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Compare secrets without exiting early on a mismatched byte. */
function constantTimeEqual(actual: string, expected: string): boolean {
  const length = Math.max(actual.length, expected.length);
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < length; index++) {
    mismatch |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function middleware(request: NextRequest) {
  const desktopRuntime = process.env.DESKTOP_RUNTIME === '1';
  if (desktopRuntime) {
    return desktopMiddleware(request);
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

function desktopMiddleware(request: NextRequest): NextResponse {
  const serviceOrigin = process.env.DESKTOP_SERVICE_ORIGIN;
  const authToken = process.env.DESKTOP_AUTH_TOKEN;
  if (!serviceOrigin || !authToken) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'DESKTOP_RUNTIME_INVALID',
        error: 'Desktop runtime unavailable',
      },
      { status: 503 },
    );
  }

  let expectedHost: string;
  try {
    expectedHost = new URL(serviceOrigin).host.toLowerCase();
  } catch {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'DESKTOP_RUNTIME_INVALID',
        error: 'Desktop runtime unavailable',
      },
      { status: 503 },
    );
  }

  if (request.headers.get('host')?.toLowerCase() !== expectedHost) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_HOST', error: 'Invalid desktop service host' },
      { status: 421 },
    );
  }

  const { pathname } = request.nextUrl;
  if (pathname === '/api/health') {
    return NextResponse.next();
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== serviceOrigin) {
      return NextResponse.json(
        { success: false, errorCode: 'INVALID_ORIGIN', error: 'Invalid desktop request origin' },
        { status: 403 },
      );
    }
  }

  const token = request.cookies.get('openmaic_desktop')?.value ?? '';
  if (constantTimeEqual(token, authToken)) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { success: false, errorCode: 'INVALID_DESKTOP_SESSION', error: 'Desktop session required' },
    { status: 401 },
  );
}

export const config = {
  matcher: ['/:path*'],
};
