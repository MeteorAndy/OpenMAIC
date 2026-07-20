import { getCurrentSession } from '@/lib/server/session';
import { getEffectivePlan, periodStartNow } from '@/lib/server/plans';
import { db } from '@/db/client';
import { usage } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/** GET /api/quota — the signed-in user's plan + current-period usage vs caps. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return apiError('UNAUTHENTICATED', 401, 'Sign in required');
  }
  const userId = session.user.id;

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
}
