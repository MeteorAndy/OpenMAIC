/**
 * Backend shim for @/lib/server/session.
 *
 * ponytail: path-overridden in backend/tsconfig.json so lib/server/quota.ts and
 * any other `import { getCurrentSession } from '@/lib/server/session'` resolve
 * HERE instead of the cookie-based Next original. userId comes from the Bearer
 * middleware via AsyncLocalStorage (src/server/auth.ts), not cookies. The public
 * shape (CurrentSession) is identical to the Next version, so callers are
 * unchanged.
 */
import { getRequestUser } from './auth';

export interface CurrentSession {
  user: { id: string };
}

/** Returns the validated session user resolved from the Bearer token, or null. */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const u = getRequestUser();
  return u ? { user: { id: u.userId } } : null;
}
