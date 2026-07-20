/**
 * /api/admin — operator endpoints (plan provisioning + usage overview).
 *
 * Guarded by authMiddleware + the ADMIN_USER_IDS env allowlist. Until a real
 * billing provider is wired, POST /subscription is how paying customers get
 * their plan (operator collects payment offline, then provisions here).
 * User records/emails live in Supabase GoTrue — manage those via Studio
 * (same compose stack); this API only handles plans + usage.
 */
import { Hono } from 'hono';
import { db } from '@/db/client';
import { plan, subscription, usage } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { setUserPlan } from '@/lib/server/billing';
import { periodStartNow } from '@/lib/server/plans';
import { isAdmin } from '@/lib/server/admin';
import { authMiddleware, type AuthVars } from '../server/auth';

export const adminRoute = new Hono<AuthVars>();
adminRoute.use('*', authMiddleware);
adminRoute.use('*', async (c, next) => {
  if (!isAdmin(c.get('userId'))) {
    return apiError('UNAUTHENTICATED', 403, 'Admin access required');
  }
  return next();
});

adminRoute.get('/plans', async (c) => {
  const plans = await db.select().from(plan).where(eq(plan.isActive, true));
  return apiSuccess({ plans });
});

/** Subscriptions joined with plan + current-period usage. */
adminRoute.get('/users', async (c) => {
  const periodStart = periodStartNow();
  const rows = await db
    .select({
      userId: subscription.userId,
      planId: subscription.planId,
      planName: plan.name,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      generations: usage.generations,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      mediaSeconds: usage.mediaSeconds,
    })
    .from(subscription)
    .leftJoin(plan, eq(subscription.planId, plan.id))
    .leftJoin(
      usage,
      and(eq(usage.userId, subscription.userId), eq(usage.periodStart, periodStart)),
    );
  return apiSuccess({ periodStart: periodStart.toISOString(), users: rows });
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
  return apiSuccess({ userId: body.userId, planId: body.planId });
});
