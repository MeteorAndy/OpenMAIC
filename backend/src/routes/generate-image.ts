/**
 * POST /api/generate/image — mirrors app/api/generate/image/route.ts.
 * Only the HTTP layer is adapted (Hono Context in place of NextRequest);
 * generateImage + provider-config + usage/quota logic is reused unchanged.
 */
import { Hono } from 'hono';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  generateImage,
  aspectRatioToDimensions,
  IMAGE_PROVIDERS,
} from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  resolveImageApiKey,
  resolveImageBaseUrl,
} from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('ImageGeneration API');

export const generateImageRoute = new Hono<AuthVars>();
generateImageRoute.use('*', authMiddleware);

generateImageRoute.post('/', async (c) => {
  try {
    const body = (await c.req.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const providerId = (c.req.header('x-image-provider') || 'seedream') as ImageProviderId;
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : c.req.header('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : c.req.header('x-base-url') || undefined;
    const clientModel = c.req.header('x-image-model') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError('MISSING_API_KEY', 401, `No API key configured for image provider: ${providerId}`);
    }

    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    if (!body.width && !body.height && body.aspectRatio) {
      const dims = aspectRatioToDimensions(body.aspectRatio);
      body.width = dims.width;
      body.height = dims.height;
    }

    log.info(
      `Generating image: provider=${providerId}, model=${clientModel || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", size=${body.width ?? 'auto'}x${body.height ?? 'auto'}`,
    );

    const result = await generateImage({ providerId, apiKey, baseUrl, model: clientModel }, body);

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId,
      modelId: clientModel,
      quantity: 1,
    });

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(
      `Image generation failed [provider=${c.req.header('x-image-provider') ?? 'seedream'}, model=${c.req.header('x-image-model') ?? 'default'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, message);
  }
});
