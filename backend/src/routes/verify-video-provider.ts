/**
 * POST /api/verify-video-provider — mirrors app/api/verify-video-provider/route.ts. Public.
 */
import { Hono } from 'hono';
import { testVideoConnectivity } from '@/lib/media/video-providers';
import { isServerConfiguredProvider, resolveVideoApiKey, resolveVideoBaseUrl } from '@/lib/server/provider-config';
import type { VideoProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VerifyVideoProvider');

export const verifyVideoProviderRoute = new Hono();

verifyVideoProviderRoute.post('/', async (c) => {
  try {
    const providerId = (c.req.header('x-video-provider') || 'seedance') as VideoProviderId;
    const model = c.req.header('x-video-model') || undefined;
    const managed = isServerConfiguredProvider('video', providerId);
    const clientApiKey = managed ? undefined : c.req.header('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : c.req.header('x-base-url') || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveVideoApiKey(providerId, clientApiKey);
    const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testVideoConnectivity({ providerId, apiKey, baseUrl, model });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    log.error(`Video provider verification failed [provider=${c.req.header('x-video-provider') ?? 'seedance'}]:`, err);
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${err}`);
  }
});
