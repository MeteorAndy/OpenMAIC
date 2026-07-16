/**
 * Per-user usage metering + quota gate (SaaS, feat/saas).
 *
 * The detailed, per-call audit log (anonymous, all modalities) stays in
 * lib/server/usage-storage.ts. THIS module owns the per-user, per-period
 * aggregate used for quota checks — one upserted row per (user, month) in the
 * `usage` table.
 *
 * Routes wrap generation handlers with assertGenerationQuota (pre-check the
 * generation-count cap) then recordGeneration (bump the aggregate by actual cost).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { usage } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getEffectivePlan, periodStartNow } from './plans';
import { apiError, API_ERROR_CODES } from './api-response';
import { getCurrentSession } from './session';
import type { NextResponse } from 'next/server';

export interface GenerationCost {
  inputTokens?: number;
  outputTokens?: number;
  mediaSeconds?: number;
}

/**
 * Returns a 402 NextResponse if the user is over their plan's generation-count cap
 * for the current period, otherwise null. null caps = unlimited.
 */
export async function assertGenerationQuota(userId: string): Promise<NextResponse | null> {
  const plan = await getEffectivePlan(userId);
  const { maxGenerationsPerPeriod, maxTokensPerPeriod, maxMediaSecondsPerPeriod } = plan;
  if (
    maxGenerationsPerPeriod == null &&
    maxTokensPerPeriod == null &&
    maxMediaSecondsPerPeriod == null
  ) {
    return null; // fully unlimited plan
  }
  const periodStart = periodStartNow();
  const rows = await db
    .select({
      generations: usage.generations,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      mediaSeconds: usage.mediaSeconds,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.periodStart, periodStart)))
    .limit(1);
  const u = rows[0];
  const usedGenerations = u?.generations ?? 0;
  const usedTokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
  const usedMediaSeconds = u?.mediaSeconds ?? 0;

  if (maxGenerationsPerPeriod != null && usedGenerations >= maxGenerationsPerPeriod) {
    return apiError(
      API_ERROR_CODES.RATE_LIMITED,
      402,
      `Generation quota reached (${usedGenerations}/${maxGenerationsPerPeriod} on the ${plan.name} plan).`,
    );
  }
  if (maxTokensPerPeriod != null && usedTokens >= maxTokensPerPeriod) {
    return apiError(
      API_ERROR_CODES.RATE_LIMITED,
      402,
      `Token quota reached (${usedTokens}/${maxTokensPerPeriod} on the ${plan.name} plan).`,
    );
  }
  if (maxMediaSecondsPerPeriod != null && usedMediaSeconds >= maxMediaSecondsPerPeriod) {
    return apiError(
      API_ERROR_CODES.RATE_LIMITED,
      402,
      `Media quota reached (${usedMediaSeconds}s/${maxMediaSecondsPerPeriod}s on the ${plan.name} plan).`,
    );
  }
  return null;
}

/** Atomically add one generation's cost to the user's current-period aggregate. */
export async function recordGeneration(userId: string, cost: GenerationCost = {}): Promise<void> {
  const periodStart = periodStartNow();
  await db
    .insert(usage)
    .values({
      id: `usage_${userId}_${periodStart.getTime()}`,
      userId,
      periodStart,
      generations: 1,
      inputTokens: cost.inputTokens ?? 0,
      outputTokens: cost.outputTokens ?? 0,
      mediaSeconds: cost.mediaSeconds ?? 0,
    })
    .onConflictDoUpdate({
      target: [usage.userId, usage.periodStart],
      set: {
        generations: sql`${usage.generations} + 1`,
        inputTokens: sql`${usage.inputTokens} + ${cost.inputTokens ?? 0}`,
        outputTokens: sql`${usage.outputTokens} + ${cost.outputTokens ?? 0}`,
        mediaSeconds: sql`${usage.mediaSeconds} + ${cost.mediaSeconds ?? 0}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Combined gate for generate routes: validates the session (DB-backed) and the
 * user's generation quota. Returns the userId on success, or a 401/402
 * NextResponse the route should return directly.
 *
 * Usage:
 *   const authed = await requireUserWithQuota();
 *   if (typeof authed !== 'string') return authed;
 *   const userId = authed;
 *   void recordGeneration(userId, { ...actualCost });
 */
export async function requireUserWithQuota(): Promise<string | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, 'Sign in required');
  }
  const over = await assertGenerationQuota(session.user.id);
  if (over) return over;
  return session.user.id;
}
