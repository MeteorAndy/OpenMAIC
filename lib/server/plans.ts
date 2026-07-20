/**
 * Subscription plans + effective-plan resolution (SaaS, feat/saas).
 * Plan caps are authoritative in the `plan` table (seeded by `pnpm db:seed`);
 * the constants here are the fallback defaults mirrored in db/seed.ts.
 */
import { db } from '@/db/client';
import { subscription, plan } from '@/db/schema';
import { eq, and, lte, gte } from 'drizzle-orm';

export interface PlanCaps {
  id: string;
  name: string;
  /** null = unlimited */
  maxGenerationsPerPeriod: number | null;
  maxTokensPerPeriod: number | null;
  maxMediaSecondsPerPeriod: number | null;
}

export const FREE_PLAN: PlanCaps = {
  id: 'free',
  name: 'Free',
  maxGenerationsPerPeriod: 20,
  maxTokensPerPeriod: 200_000,
  maxMediaSecondsPerPeriod: 60,
};

/** Plan row incl. price — the shape db/seed.ts upserts and /pricing renders. */
export interface SeedPlan extends PlanCaps {
  priceMonthlyCents: number;
}

/** Canonical plan list: single source for db:seed and the /pricing fallback. */
export const DEFAULT_PLANS: SeedPlan[] = [
  { ...FREE_PLAN, priceMonthlyCents: 0 },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyCents: 1900,
    maxGenerationsPerPeriod: 500,
    maxTokensPerPeriod: 10_000_000,
    maxMediaSecondsPerPeriod: 1800,
  },
  {
    id: 'team',
    name: 'Team',
    priceMonthlyCents: 9900,
    maxGenerationsPerPeriod: null,
    maxTokensPerPeriod: null,
    maxMediaSecondsPerPeriod: null,
  },
];

/** Start of the current UTC calendar month — the usage reset boundary. */
export function periodStartNow(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The plan caps that apply to a user right now: their active subscription's plan
 * if one covers the current time, else the Free fallback (so quota always works
 * even before `db:seed` has run or before a subscription row exists).
 */
export async function getEffectivePlan(userId: string): Promise<PlanCaps> {
  try {
    const now = new Date();
    const rows = await db
      .select({
        id: plan.id,
        name: plan.name,
        maxGenerationsPerPeriod: plan.maxGenerationsPerPeriod,
        maxTokensPerPeriod: plan.maxTokensPerPeriod,
        maxMediaSecondsPerPeriod: plan.maxMediaSecondsPerPeriod,
      })
      .from(subscription)
      .innerJoin(plan, eq(subscription.planId, plan.id))
      .where(
        and(
          eq(subscription.userId, userId),
          eq(subscription.status, 'active'),
          lte(subscription.currentPeriodStart, now),
          gte(subscription.currentPeriodEnd, now),
        ),
      )
      .limit(1);
    const p = rows[0];
    if (!p) return FREE_PLAN;
    return {
      id: p.id,
      name: p.name,
      maxGenerationsPerPeriod: p.maxGenerationsPerPeriod,
      maxTokensPerPeriod: p.maxTokensPerPeriod,
      maxMediaSecondsPerPeriod: p.maxMediaSecondsPerPeriod,
    };
  } catch {
    // DB unavailable (e.g. not yet migrated) — degrade to free so the app still runs.
    return FREE_PLAN;
  }
}
