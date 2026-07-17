/**
 * Server-side session access for API routes / server components (Supabase GoTrue).
 * Returns a minimal { user: { id } } so callers (quota.ts) keep their existing shape.
 */
import { createClient } from '@/lib/supabase/server';
import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { getRequestUser } from '@/lib/server/request-als';
import type { NextResponse } from 'next/server';

export interface CurrentSession {
  user: { id: string };
}

/**
 * Returns the validated session user, or null.
 *
 * In the compiled Bun/Hono backend, the Bearer authMiddleware populates the
 * shared AsyncLocalStorage (lib/server/request-als) — read it first, avoiding
 * the cookie-based SSR client entirely (cookies() is unavailable there). In
 * Next, the store is never set, so we fall through to the SSR client unchanged.
 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const backendUser = getRequestUser();
  if (backendUser) {
    return { user: { id: backendUser.userId } };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { user: { id: user.id } } : null;
}

/** Returns the current user id, or a 401 NextResponse if unauthenticated. */
export async function requireUserId(): Promise<string | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, 'Sign in required');
  }
  return session.user.id;
}
