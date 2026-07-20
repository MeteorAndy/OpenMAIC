/**
 * /api/billing — provider-agnostic billing endpoints.
 *
 * Checkout/portal are authenticated and delegate to the configured
 * BillingProvider (BILLING_PROVIDER, default `manual` -> 501). The webhook is
 * intentionally public: the provider verifies authenticity itself
 * (stripe signature / wechat pay cert) inside handleWebhook.
 */
import { Hono } from 'hono';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { BillingNotImplementedError, getBillingProvider } from '@/lib/server/billing';
import { authMiddleware, type AuthVars } from '../server/auth';

export const billingRoute = new Hono<AuthVars>();

billingRoute.post('/webhook', async (c) => {
  // Public by design — the provider validates the signature on the raw request.
  return getBillingProvider().handleWebhook(c.req.raw);
});

billingRoute.post('/checkout', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { planId?: string };
  if (!body.planId) return apiError('MISSING_REQUIRED_FIELD', 400, 'planId is required');
  try {
    const { checkoutUrl } = await getBillingProvider().createCheckoutSession({
      userId: c.get('userId'),
      planId: body.planId,
    });
    return apiSuccess({ checkoutUrl });
  } catch (err) {
    if (err instanceof BillingNotImplementedError) {
      return apiError('PROVIDER_DISABLED', 501, err.message);
    }
    throw err;
  }
});

billingRoute.post('/portal', authMiddleware, async (c) => {
  try {
    const { portalUrl } = await getBillingProvider().createPortalSession({ userId: c.get('userId') });
    return apiSuccess({ portalUrl });
  } catch (err) {
    if (err instanceof BillingNotImplementedError) {
      return apiError('PROVIDER_DISABLED', 501, err.message);
    }
    throw err;
  }
});
