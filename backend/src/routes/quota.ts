/**
 * GET /api/quota — the signed-in user's plan + current-period usage vs caps.
 * Mirrors app/api/quota/route.ts. The only change vs Next: getCurrentSession
 * is the backend shim (Bearer -> userId via AsyncLocalStorage), set by the
 * authMiddleware mounted on this sub-app.
 */
import { Hono } from 'hono';
import { getEffectivePlan, periodStartNow } from '@/lib/server/plans';
import { db } from '@/db/client';
import { usage } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiSuccess } from '@/lib/server/api-response';
import { authMiddleware, type AuthVars } from '../server/auth';

export const quota = new Hono<AuthVars>();
quota.use('*', authMiddleware);

quota.get('/', async (c) => {
  // userId validated by the Bearer authMiddleware; no cookie session needed.
  const userId = c.get('userId');

  const plan = await getEffectivePlan(userId);
  const periodStart = periodStartNow();
  const rows = await db
    .select()
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.periodStart, periodStart)))
    .limit(1);
  const u = rows[0];

  return apiSuccess({
    plan: { id: plan.id, name: plan.name },
    periodStart: periodStart.toISOString(),
    usage: {
      generations: u?.generations ?? 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      mediaSeconds: u?.mediaSeconds ?? 0,
    },
    caps: {
      maxGenerationsPerPeriod: plan.maxGenerationsPerPeriod,
      maxTokensPerPeriod: plan.maxTokensPerPeriod,
      maxMediaSecondsPerPeriod: plan.maxMediaSecondsPerPeriod,
    },
  });
});
