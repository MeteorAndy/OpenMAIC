/**
 * Operator views over Supabase GoTrue's `auth.users` (SaaS, feat/saas).
 *
 * The business DB and GoTrue share one Postgres, so the admin API reads
 * auth.users directly (the DATABASE_URL role is a superuser in this stack)
 * and calls GoTrue's admin REST API for mutations (ban/unban) so GoTrue's
 * own bookkeeping (refresh-token revocation) stays correct.
 */
import { db } from '@/db/client';
import { sql } from 'drizzle-orm';

export interface AdminUserRow {
  userId: string;
  email: string | null;
  /** timestamptz string; non-null and in the future = currently banned. */
  bannedUntil: string | null;
  planId: string | null;
  planName: string | null;
  status: string | null;
  currentPeriodEnd: string | null;
  generations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  mediaSeconds: number | null;
}

/** Every registered account, newest first (cap 500 — paginate when this hurts). */
export async function listAdminUsers(periodStart: Date): Promise<AdminUserRow[]> {
  const rows = await db.execute(sql`
    select
      u.id::text                     as "userId",
      u.email::text                  as "email",
      u.banned_until                 as "bannedUntil",
      s.plan_id                      as "planId",
      p.name                         as "planName",
      s.status                       as "status",
      s.current_period_end           as "currentPeriodEnd",
      g.generations                  as "generations",
      g.input_tokens                 as "inputTokens",
      g.output_tokens                as "outputTokens",
      g.media_seconds                as "mediaSeconds"
    from auth.users u
    left join public.subscription s on s.user_id = u.id
    left join public.plan p         on p.id = s.plan_id
    left join public.usage g        on g.user_id = u.id and g.period_start = ${periodStart.toISOString()}::timestamptz
    order by u.created_at desc
    limit 500
  `);
  return rows as unknown as AdminUserRow[];
}

export async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`select u.email::text as email from auth.users u where u.id = ${userId} limit 1`,
  );
  const first = (rows as unknown as { email: string | null }[])[0];
  return first?.email ?? null;
}

/**
 * Ban (block sign-in + revoke refresh tokens) or unban via GoTrue's admin API.
 * Requires SUPABASE_SERVICE_ROLE_KEY. Ban duration 100 years ≈ permanent.
 */
export async function setUserBanned(userId: string, banned: boolean): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL not set');
  }
  const res = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none' }),
  });
  if (!res.ok) {
    throw new Error(`GoTrue admin ${banned ? 'ban' : 'unban'} failed: ${res.status} ${await res.text()}`);
  }
}
