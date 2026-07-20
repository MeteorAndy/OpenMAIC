import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/** Public paths: landing + auth pages + health. Everything else requires a Supabase session. */
function isPublic(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/pricing' ||
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/api/health' ||
    // Supabase auth callback / verify endpoints if proxied through the app.
    pathname.startsWith('/auth/')
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /api/* requests carrying an Authorization header are authenticated by the
  // compiled backend (JWKS), not by the cookie session — let them pass so the
  // proxy stays a dumb pipe (public deployments expose only the Next origin,
  // so direct API clients must be able to use Bearer through it). Cookie-based
  // browser requests fall through to the session gate below.
  if (pathname.startsWith('/api/') && request.headers.get('authorization')) {
    return NextResponse.next();
  }

  const { user, response } = await updateSession(request);

  if (!user && !isPublic(pathname)) {
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

  return response;
}

export const config = {
  matcher: [
    // Skip Next internals, static assets, and Supabase studio paths.
    '/((?!_next/static|_next/image|favicon.ico|logos/).*)',
  ],
};
