/**
 * POST /api/verify-image-provider — mirrors app/api/verify-image-provider/route.ts. Public.
 */
import { Hono } from 'hono';
import { IMAGE_PROVIDERS, testImageConnectivity } from '@/lib/media/image-providers';
import { isServerConfiguredProvider, resolveImageApiKey, resolveImageBaseUrl } from '@/lib/server/provider-config';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VerifyImageProvider');

export const verifyImageProviderRoute = new Hono();

verifyImageProviderRoute.post('/', async (c) => {
  try {
    const providerId = (c.req.header('x-image-provider') || 'seedream') as ImageProviderId;
    const model = c.req.header('x-image-model') || undefined;
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : c.req.header('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : c.req.header('x-base-url') || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testImageConnectivity({ providerId, apiKey, baseUrl, model });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    log.error(`Image provider verification failed [provider=${c.req.header('x-image-provider') ?? 'seedream'}]:`, err);
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${err}`);
  }
});
