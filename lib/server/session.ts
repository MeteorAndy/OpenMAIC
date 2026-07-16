/**
 * Server-side session access for API routes / server components.
 * Full validation (DB-backed) lives here, not in middleware.
 */
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';

export type CurrentSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/** Returns the validated session (user + session) or null. */
export async function getCurrentSession(): Promise<CurrentSession> {
  return auth.api.getSession({ headers: await headers() });
}

/**
 * Returns the current user id, or a 401 NextResponse if unauthenticated.
 * Usage in routes: `const userId = await requireUserId(); if (typeof userId !== 'string') return userId;`
 */
export async function requireUserId(): Promise<string | ReturnType<typeof apiError>> {
  const s = await getCurrentSession();
  if (!s) {
    return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, 'Sign in required');
  }
  return s.user.id;
}
