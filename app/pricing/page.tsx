import { asc, eq } from 'drizzle-orm';
import { plan } from '@/db/schema';
import { DEFAULT_PLANS, type SeedPlan } from '@/lib/server/plans';
import { CheckoutButton } from './checkout-button';

// Plan table reads must happen per-request, never at build time.
export const dynamic = 'force-dynamic';

async function loadPlans(): Promise<SeedPlan[]> {
  try {
    // db/client throws at module evaluation when DATABASE_URL is unset, so it
    // must be imported lazily inside the try for the fallback to engage.
    const { db } = await import('@/db/client');
    const rows = await db
      .select({
        id: plan.id,
        name: plan.name,
        priceMonthlyCents: plan.priceMonthlyCents,
        maxGenerationsPerPeriod: plan.maxGenerationsPerPeriod,
        maxTokensPerPeriod: plan.maxTokensPerPeriod,
        maxMediaSecondsPerPeriod: plan.maxMediaSecondsPerPeriod,
      })
      .from(plan)
      .where(eq(plan.isActive, true))
      .orderBy(asc(plan.priceMonthlyCents));
    return rows.length > 0 ? rows : DEFAULT_PLANS;
  } catch {
    return DEFAULT_PLANS;
  }
}

function formatPrice(cents: number): string {
  return cents === 0 ? '免费' : `¥${cents / 100}/月`;
}

function formatQuota(value: number | null, unit: string): string {
  return value === null ? '不限' : `${value.toLocaleString()} ${unit}`;
}

export default async function PricingPage() {
  const plans = await loadPlans();

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-16">
      <div className="mx-auto max-w-5xl space-y-10">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold">定价</h1>
          <p className="text-sm text-muted-foreground">选择适合你的套餐,随时升级</p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.id}
              className="flex flex-col space-y-6 rounded-xl border bg-card p-8 shadow-sm"
            >
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                <p className="text-3xl font-semibold">{formatPrice(p.priceMonthlyCents)}</p>
              </div>

              <ul className="flex-1 space-y-2 text-sm text-muted-foreground">
                <li>每月生成次数:{formatQuota(p.maxGenerationsPerPeriod, '次')}</li>
                <li>Token 额度:{formatQuota(p.maxTokensPerPeriod, 'tokens')}</li>
                <li>媒体生成:{formatQuota(p.maxMediaSecondsPerPeriod, '秒')}</li>
              </ul>

              <CheckoutButton
                planId={p.id}
                label={p.priceMonthlyCents === 0 ? '免费使用' : '立即开通'}
                href={p.priceMonthlyCents === 0 ? '/signup' : undefined}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
