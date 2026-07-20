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
import { plan } from '@/db/schema';
import { eq } from 'drizzle-orm';
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

adminRoute.get('/plans', async (c) => {
  const plans = await db.select().from(plan).where(eq(plan.isActive, true));
  return apiSuccess({ plans });
});

/** Every registered account (email included) + plan + current-period usage. */
adminRoute.get('/users', async (c) => {
  const periodStart = periodStartNow();
  const users = await listAdminUsers(periodStart);
  return apiSuccess({ periodStart: periodStart.toISOString(), users });
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
