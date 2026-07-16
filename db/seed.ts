/**
 * Seed subscription plans (Free / Pro / Team). Run once after migrate:
 *   DATABASE_URL=... pnpm db:seed
 * Idempotent (upsert). Caps mirror lib/server/plans.ts FREE_PLAN defaults.
 */
import { db } from './client';
import { plan } from './schema';

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthlyCents: 0,
    maxGenerationsPerPeriod: 20,
    maxTokensPerPeriod: 200_000,
    maxMediaSecondsPerPeriod: 60,
  },
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
] as const;

async function main() {
  for (const p of PLANS) {
    await db
      .insert(plan)
      .values({
        id: p.id,
        name: p.name,
        priceMonthlyCents: p.priceMonthlyCents,
        maxGenerationsPerPeriod: p.maxGenerationsPerPeriod,
        maxTokensPerPeriod: p.maxTokensPerPeriod,
        maxMediaSecondsPerPeriod: p.maxMediaSecondsPerPeriod,
      })
      .onConflictDoUpdate({
        target: plan.id,
        set: {
          name: p.name,
          priceMonthlyCents: p.priceMonthlyCents,
          maxGenerationsPerPeriod: p.maxGenerationsPerPeriod,
          maxTokensPerPeriod: p.maxTokensPerPeriod,
          maxMediaSecondsPerPeriod: p.maxMediaSecondsPerPeriod,
        },
      });
    console.log(`upserted plan: ${p.id}`);
  }
  console.log('seed done');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
