/**
 * POST /api/generate/video — mirrors app/_api_archive/generate/video/route.ts.
 * HTTP layer only; generateVideo + provider-config reused unchanged.
 */
import { Hono } from 'hono';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import {
  isServerConfiguredProvider,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
} from '@/lib/server/provider-config';
import type { VideoProviderId, VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('VideoGeneration API');

export const generateVideoRoute = new Hono<AuthVars>();
generateVideoRoute.use('*', authMiddleware);

generateVideoRoute.post('/', async (c) => {
  try {
    const body = (await c.req.json()) as VideoGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const providerId = (c.req.header('x-video-provider') || 'seedance') as VideoProviderId;
    const managed = isServerConfiguredProvider('video', providerId);
    const clientApiKey = managed ? undefined : c.req.header('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : c.req.header('x-base-url') || undefined;
    const clientModel = c.req.header('x-video-model') || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveVideoApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError('MISSING_API_KEY', 401, `No API key configured for video provider: ${providerId}`);
    }

    const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);
    const options = normalizeVideoOptions(providerId, body);

    log.info(
      `Generating video: provider=${providerId}, model=${clientModel || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", duration=${options.duration ?? 'auto'}, ` +
        `aspect=${options.aspectRatio ?? 'auto'}, resolution=${options.resolution ?? 'auto'}`,
    );

    const result = await generateVideo({ providerId, apiKey, baseUrl, model: clientModel }, options);

    log.info(`Video generated: url=${result.url ? 'yes' : 'no'}, ${result.width}x${result.height}, ${result.duration}s`);

    void recordGenerationUsage({
      kind: 'video',
      unit: 'second',
      providerId,
      modelId: clientModel,
      quantity: result.duration,
    });

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Video blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(
      `Video generation failed [provider=${c.req.header('x-video-provider') ?? 'kling'}, model=${c.req.header('x-video-model') ?? 'default'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, message);
  }
});
