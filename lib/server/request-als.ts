/**
 * Shared per-request user AsyncLocalStorage.
 *
 * Both the compiled Bun/Hono backend and the Next app import this. The backend
 * authMiddleware runs a request inside the store; Next never does, so its
 * presence is a reliable "are we in the Bearer-authed backend?" signal.
 *
 * Why this exists: lib/server/session.ts needs the validated userId in the
 * backend, but it can't import the backend's auth.ts (that pulls in hono/jose
 * and breaks Next). A neutral shared module breaks the cycle — both sides
 * resolve it via normal relative/@ imports, no build-time shim required.
 * AsyncLocalStorage preserves per-request isolation under concurrency (unlike a
 * global), so concurrent requests can't leak userIds.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestUser {
  userId: string;
  token: string;
}

const store = new AsyncLocalStorage<RequestUser>();

/** Run `fn` inside a request user scope (backend authMiddleware). */
export function runRequestUser<T>(u: RequestUser, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(store.run(u, fn));
}

/** Read the per-request user, or null if outside a backend request scope. */
export function getRequestUser(): RequestUser | null {
  return store.getStore() ?? null;
}
