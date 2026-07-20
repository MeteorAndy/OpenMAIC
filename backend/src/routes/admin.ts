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
import { plan, subscription, usage } from '@/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { setUserPlan } from '@/lib/server/billing';
import { periodStartNow } from '@/lib/server/plans';
import { isAdmin } from '@/lib/server/admin';
import { getUserEmail, listAdminUsers, setUserBanned } from '@/lib/server/admin-users';
import { getEmailProvider } from '@/lib/server/email';
import { recordAudit } from '@/lib/server/audit';
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
  const periodStart = periodStartNow().toISOString();
  const [stats] = (await db.execute(sql`
    select
      (select count(*)::int from auth.users) as "totalUsers",
      (select count(*)::int from auth.users
        where banned_until is not null and banned_until > now()) as "bannedUsers",
      (select count(*)::int from public.subscription
        where status = 'active' and plan_id <> 'free' and current_period_end > now()) as "paidUsers",
      (select coalesce(sum(generations), 0)::int from public.usage
        where period_start = ${periodStart}::timestamptz) as "generations",
      (select coalesce(sum(input_tokens + output_tokens), 0)::bigint from public.usage
        where period_start = ${periodStart}::timestamptz) as "tokens",
      (select coalesce(sum(media_seconds), 0)::int from public.usage
        where period_start = ${periodStart}::timestamptz) as "mediaSeconds"
  `)) as unknown as {
    totalUsers: number;
    bannedUsers: number;
    paidUsers: number;
    generations: number;
    tokens: string;
    mediaSeconds: number;
  }[];
  return apiSuccess({ periodStart, ...stats });
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

  const before = await db.select().from(plan).where(eq(plan.id, planId)).limit(1);
  if (before.length === 0) return apiError('INVALID_REQUEST', 404, `plan '${planId}' not found`);

  const updated = await db.update(plan).set(patch).where(eq(plan.id, planId)).returning();
  log.info(`plan updated: ${planId} ${JSON.stringify(patch)} by admin=${c.get('userId')}`);
  await recordAudit({
    actorUserId: c.get('userId'),
    action: 'plan.update',
    targetType: 'plan',
    targetId: planId,
    detail: { before: before[0], after: updated[0] },
  });
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
  const before = await db
    .select()
    .from(subscription)
    .where(eq(subscription.userId, body.userId))
    .limit(1);
  try {
    await setUserPlan(body.userId, body.planId);
  } catch (err) {
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : 'Failed to set plan');
  }
  await recordAudit({
    actorUserId: c.get('userId'),
    action: 'subscription.set',
    targetType: 'user',
    targetId: body.userId,
    detail: { fromPlanId: before[0]?.planId ?? null, toPlanId: body.planId },
  });
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
  await recordAudit({
    actorUserId: c.get('userId'),
    action: banned ? 'user.ban' : 'user.unban',
    targetType: 'user',
    targetId: userId,
  });
  return apiSuccess({ userId, banned });
}

/**
 * Audit trail, newest first. ?limit (default 50, max 200) + ?offset.
 * Actor/target emails are joined from auth.users (target email only when the
 * target is a user; plan targets show the plan id).
 */
adminRoute.get('/audit-log', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const rows = (await db.execute(sql`
    select
      l.id,
      l.action,
      l.target_type        as "targetType",
      l.target_id          as "targetId",
      l.detail,
      l.created_at         as "createdAt",
      l.actor_user_id      as "actorUserId",
      a.email::text        as "actorEmail",
      t.email::text        as "targetEmail"
    from public.admin_audit_log l
    left join auth.users a on a.id = l.actor_user_id
    left join auth.users t on l.target_type = 'user' and t.id::text = l.target_id
    order by l.created_at desc
    limit ${limit} offset ${offset}
  `)) as unknown as Record<string, unknown>[];
  const [countRow] = (await db.execute(
    sql`select count(*)::int as total from public.admin_audit_log`,
  )) as unknown as { total: number }[];
  return apiSuccess({ total: countRow.total, entries: rows });
});
