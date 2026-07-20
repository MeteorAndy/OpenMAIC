/**
 * Seed subscription plans (Free / Pro / Team). Run once after migrate:
 *   DATABASE_URL=... pnpm db:seed
 * Idempotent (upsert). Plan rows come from lib/server/plans.ts DEFAULT_PLANS
 * (single source shared with the /pricing fallback).
 */
import { db } from './client';
import { plan } from './schema';
import { DEFAULT_PLANS } from '../lib/server/plans';

async function main() {
  for (const p of DEFAULT_PLANS) {
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
