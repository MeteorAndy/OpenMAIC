/**
 * /api/admin — operator endpoints (plan provisioning + user/usage management).
 *
 * Guarded by authMiddleware + the ADMIN_USER_IDS env allowlist. Until a real
 * billing provider is wired, POST /subscription is how paying customers get
 * their plan (operator collects payment offline, then provisions here; the
 * user gets a plan-activated email when EMAIL_PROVIDER is configured).
 */
import { Hono, type Context } from 'hono';
import { db } from '@/db/client';
import { plan, usage } from '@/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { setUserPlan } from '@/lib/server/billing';
import { periodStartNow } from '@/lib/server/plans';
import { isAdmin } from '@/lib/server/admin';
import { getUserEmail, listAdminUsers, setUserBanned } from '@/lib/server/admin-users';
import { getEmailProvider } from '@/lib/server/email';
import { createLogger } from '@/lib/logger';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('Admin');

export const adminRoute = new Hono<AuthVars>();
adminRoute.use('*', authMiddleware);
adminRoute.use('*', async (c, next) => {
  if (!isAdmin(c.get('userId'))) {
    return apiError('UNAUTHENTICATED', 403, 'Admin access required');
  }
  return next();
});

/** Business KPIs for the dashboard header. */
adminRoute.get('/overview', async (c) => {
  const periodStart = periodStartNow();
  const [userStats] = (await db.execute(sql`
    select
      count(*)::int as "totalUsers",
      count(*) filter (where banned_until is not null and banned_until > now())::int as "bannedUsers"
    from auth.users
  `)) as unknown as { totalUsers: number; bannedUsers: number }[];
  const [subStats] = (await db.execute(sql`
    select count(*)::int as "paidUsers"
    from public.subscription
    where status = 'active' and plan_id <> 'free' and current_period_end > now()
  `)) as unknown as { paidUsers: number }[];
  const [usageStats] = (await db.execute(sql`
    select
      coalesce(sum(generations), 0)::int as "generations",
      coalesce(sum(input_tokens + output_tokens), 0)::bigint as "tokens",
      coalesce(sum(media_seconds), 0)::int as "mediaSeconds"
    from public.usage
    where period_start = ${periodStart.toISOString()}::timestamptz
  `)) as unknown as { generations: number; tokens: number; mediaSeconds: number }[];
  return apiSuccess({
    periodStart: periodStart.toISOString(),
    ...userStats,
    ...subStats,
    ...usageStats,
  });
});

/** All plans (incl. inactive) for management; the public /pricing page filters. */
adminRoute.get('/plans', async (c) => {
  const plans = await db.select().from(plan).orderBy(plan.priceMonthlyCents);
  return apiSuccess({ plans });
});

/** Edit a plan's price / caps / visibility. null cap = unlimited. */
adminRoute.put('/plans/:id', async (c) => {
  const planId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    priceMonthlyCents?: number;
    maxGenerationsPerPeriod?: number | null;
    maxTokensPerPeriod?: number | null;
    maxMediaSecondsPerPeriod?: number | null;
    isActive?: boolean;
  } | null;
  if (!body) return apiError('INVALID_REQUEST', 400, 'JSON body required');

  const patch: Partial<typeof plan.$inferInsert> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return apiError('INVALID_REQUEST', 400, 'name must be non-empty');
    patch.name = body.name.trim();
  }
  if (body.priceMonthlyCents !== undefined) {
    if (!Number.isInteger(body.priceMonthlyCents) || body.priceMonthlyCents < 0) {
      return apiError('INVALID_REQUEST', 400, 'priceMonthlyCents must be a non-negative integer');
    }
    patch.priceMonthlyCents = body.priceMonthlyCents;
  }
  for (const key of ['maxGenerationsPerPeriod', 'maxTokensPerPeriod', 'maxMediaSecondsPerPeriod'] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      if (v !== null && (!Number.isInteger(v) || v <= 0)) {
        return apiError('INVALID_REQUEST', 400, `${key} must be a positive integer or null`);
      }
      patch[key] = v;
    }
  }
  if (body.isActive !== undefined) patch.isActive = !!body.isActive;
  if (Object.keys(patch).length === 0) {
    return apiError('INVALID_REQUEST', 400, 'nothing to update');
  }

  const updated = await db.update(plan).set(patch).where(eq(plan.id, planId)).returning();
  if (updated.length === 0) return apiError('INVALID_REQUEST', 404, `plan '${planId}' not found`);
  log.info(`plan updated: ${planId} ${JSON.stringify(patch)} by admin=${c.get('userId')}`);
  return apiSuccess({ plan: updated[0] });
});

/** Every registered account (email included) + plan + current-period usage. */
adminRoute.get('/users', async (c) => {
  const periodStart = periodStartNow();
  const users = await listAdminUsers(periodStart);
  return apiSuccess({ periodStart: periodStart.toISOString(), users });
});

/** One user's usage history, newest period first (last 12). */
adminRoute.get('/users/:id/usage', async (c) => {
  const userId = c.req.param('id');
  const rows = await db
    .select()
    .from(usage)
    .where(eq(usage.userId, userId))
    .orderBy(desc(usage.periodStart))
    .limit(12);
  return apiSuccess({ userId, usage: rows });
});

adminRoute.post('/subscription', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { userId?: string; planId?: string };
  if (!body.userId || !body.planId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'userId and planId are required');
  }
  try {
    await setUserPlan(body.userId, body.planId);
  } catch (err) {
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : 'Failed to set plan');
  }
  // Plan-activated notice — fire-and-forget: a mail outage must not fail provisioning.
  void (async () => {
    try {
      const email = await getUserEmail(body.userId!);
      if (!email) return;
      await getEmailProvider().send({
        to: email,
        subject: '你的 OpenMAIC 套餐已开通',
        html: `<p>你好,</p><p>你的账号(${email})已开通 <b>${body.planId}</b> 套餐,即刻生效。感谢支持!</p><p>— OpenMAIC 团队</p>`,
      });
    } catch (err) {
      log.warn(`plan-activated email failed for user=${body.userId}: ${err instanceof Error ? err.message : err}`);
    }
  })();
  return apiSuccess({ userId: body.userId, planId: body.planId });
});

/** Ban = block sign-in + revoke refresh tokens (GoTrue admin API). */
adminRoute.post('/users/:id/ban', async (c) => setBanned(c, true));
adminRoute.post('/users/:id/unban', async (c) => setBanned(c, false));

async function setBanned(c: Context<AuthVars>, banned: boolean) {
  const userId = c.req.param('id');
  if (!userId) return apiError('MISSING_REQUIRED_FIELD', 400, 'user id is required');
  try {
    await setUserBanned(userId, banned);
  } catch (err) {
    return apiError('INTERNAL_ERROR', 502, err instanceof Error ? err.message : 'GoTrue admin call failed');
  }
  log.info(`user ${banned ? 'banned' : 'unbanned'}: ${userId} by admin=${c.get('userId')}`);
  return apiSuccess({ userId, banned });
}
