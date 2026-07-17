/**
 * Backend shim for @/lib/supabase/server.
 *
 * ponytail: path-overridden so any RLS-bearing query (queries.ts) that imports
 * createClient from '@/lib/supabase/server' gets a per-request Bearer-impersonating
 * client instead of the cookie-based SSR client. GoTrue sets request.jwt.claims.sub
 * from the Authorization header so auth.uid() matches the caller — RLS behaves
 * identically to the Next SSR path. Not exercised by the Phase-1 routes
 * (health/quota/chat go through the Drizzle admin connection), but wired so the
 * ~36 ported routes in Phase 2 work without re-plumbing.
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { getRequestUser } from './auth';

/**
 * Returns a per-request Supabase client scoped to the caller's Bearer token.
 * Throws if called outside an authenticated request — protected routes set the
 * store before dispatching.
 */
export async function createClient() {
  const u = getRequestUser();
  if (!u) {
    throw new Error('[backend] createClient() called outside an authenticated request');
  }
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${u.token}` } },
      // No session persistence — the backend is stateless; refresh is the client's job.
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
