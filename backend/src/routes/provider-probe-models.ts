/**
 * POST /api/provider/probe-models — mirrors app/_api_archive/provider/probe-models/route.ts. Public.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchModels, ModelFetchError } from '@/lib/server/model-fetch';

const log = createLogger('ProbeModels');

const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;

export const providerProbeModelsRoute = new Hono();

providerProbeModelsRoute.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { baseUrl, apiKey, modelsUrl } = body as { baseUrl?: string; apiKey?: string; modelsUrl?: string };

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'baseUrl is required');
    }

    for (const url of [baseUrl, modelsUrl].filter(Boolean) as string[]) {
      const ssrfError = await validateUrlForSSRF(url);
      if (ssrfError) return apiError('INVALID_REQUEST', 400, ssrfError);
    }

    const models = await fetchModels(baseUrl, apiKey || '', { modelsUrlOverride: modelsUrl });
    const chatModels = models.filter((m) => !NON_CHAT_PATTERN.test(m.id));

    return apiSuccess({
      models: chatModels.map((m) => ({ id: m.id, ownedBy: m.ownedBy })),
      total: models.length,
      filtered: models.length - chatModels.length,
    });
  } catch (error) {
    if (error instanceof ModelFetchError) {
      if (error.status === 401 || error.status === 403) {
        return apiError('INVALID_REQUEST', 401, 'API key is invalid or expired');
      }
      if (error.status === 404) {
        return apiError('INVALID_REQUEST', 404, 'This provider does not expose a model list');
      }
      return apiError('INTERNAL_ERROR', 502, error.message);
    }
    log.error('Model probe failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed to probe models');
  }
});
