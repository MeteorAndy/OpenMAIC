/**
 * Billing seam (SaaS, feat/saas).
 *
 * The skeleton ships with the `manual` provider only: plans are provisioned by
 * an operator through the admin API (POST /api/admin/subscription), which calls
 * `setUserPlan` directly. Checkout/portal return 501 so the UI can show a
 * "contact us" state instead of a broken flow.
 *
 * Wiring a real provider (Stripe / 微信支付 / 支付宝) later:
 *   1. Implement `BillingProvider` in a sibling file (e.g. billing-stripe.ts).
 *      - createCheckoutSession: provider checkout for planId; put our userId in
 *        the provider's metadata/client_reference_id so webhooks can map back.
 *      - handleWebhook: verify the signature, then call `setUserPlan` /
 *        `cancelUserPlan` below — all DB writes live here, providers stay dumb.
 *   2. Register it in `getBillingProvider()` below.
 *   3. Set BILLING_PROVIDER + the provider's keys in env. No other code changes.
 */
import { db } from '@/db/client';
import { plan, subscription } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('Billing');

export interface BillingProvider {
  readonly id: string;
  /** Start a hosted checkout for the given plan. */
  createCheckoutSession(args: { userId: string; planId: string }): Promise<{ checkoutUrl: string }>;
  /** Open the provider's self-service portal (upgrade/cancel/payment methods). */
  createPortalSession(args: { userId: string }): Promise<{ portalUrl: string }>;
  /**
   * Verify and apply a provider webhook. Must validate authenticity itself
   * (signature / IP allowlist) — the route is public by design.
   */
  handleWebhook(req: Request): Promise<Response>;
}

/** Thrown by providers that don't implement a flow; routes map it to 501. */
export class BillingNotImplementedError extends Error {}

// ---------------------------------------------------------------------------
// Shared subscription mutations — the only writes a provider ever needs.
// ---------------------------------------------------------------------------

const DEFAULT_PERIOD_DAYS = 30;

/**
 * Give a user a plan: upsert their single subscription row as active for the
 * period (default: now .. now+30d). Used by the admin API today and by real
 * provider webhooks later.
 */
export async function setUserPlan(
  userId: string,
  planId: string,
  period?: { start: Date; end: Date },
): Promise<void> {
  const planRow = (await db.select().from(plan).where(eq(plan.id, planId)).limit(1))[0];
  if (!planRow) {
    throw new Error(`Unknown plan '${planId}' — seed plans first (pnpm db:seed)`);
  }
  const start = period?.start ?? new Date();
  const end = period?.end ?? new Date(start.getTime() + DEFAULT_PERIOD_DAYS * 86_400_000);
  const now = new Date();
  await db
    .insert(subscription)
    .values({
      id: crypto.randomUUID(),
      userId,
      planId,
      status: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscription.userId,
      set: { planId, status: 'active', currentPeriodStart: start, currentPeriodEnd: end, updatedAt: now },
    });
  log.info(`subscription set: user=${userId} plan=${planId} until=${end.toISOString()}`);
}

/** Mark a user's subscription canceled (quota falls back to the Free caps). */
export async function cancelUserPlan(userId: string): Promise<void> {
  await db
    .update(subscription)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(subscription.userId, userId));
  log.info(`subscription canceled: user=${userId}`);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const manualProvider: BillingProvider = {
  id: 'manual',
  createCheckoutSession: () => {
    throw new BillingNotImplementedError(
      'Online checkout is not enabled on this deployment — plans are provisioned by the operator.',
    );
  },
  createPortalSession: () => {
    throw new BillingNotImplementedError(
      'Self-service billing is not enabled on this deployment — contact the operator.',
    );
  },
  handleWebhook: () =>
    Promise.resolve(
      Response.json({ success: false, error: 'No billing provider configured' }, { status: 404 }),
    ),
};

const providers: Record<string, () => BillingProvider> = {
  manual: () => manualProvider,
  // stripe: () => stripeProvider,  // <- real integrations register here
};

/** Active provider, selected by BILLING_PROVIDER (default: manual). */
export function getBillingProvider(): BillingProvider {
  const id = (process.env.BILLING_PROVIDER ?? 'manual').trim() || 'manual';
  const factory = providers[id];
  if (!factory) {
    log.warn(`unknown BILLING_PROVIDER '${id}', falling back to manual`);
    return manualProvider;
  }
  return factory();
}
