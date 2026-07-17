/**
 * POST /api/transcription — mirrors app/api/transcription/route.ts.
 * multipart/form-data via c.req.raw.formData(); HTTP layer only.
 */
import { Hono } from 'hono';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { isServerConfiguredProvider, resolveASRApiKey, resolveASRBaseUrl } from '@/lib/server/provider-config';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('Transcription');

export const transcriptionRoute = new Hono<AuthVars>();
transcriptionRoute.use('*', authMiddleware);

transcriptionRoute.post('/', async (c) => {
  let resolvedProviderId: string | undefined;
  let resolvedModelId: string | undefined;
  try {
    const formData = await c.req.raw.formData();
    const audioFile = formData.get('audio') as File;
    const providerId = formData.get('providerId') as ASRProviderId | null;
    const modelId = formData.get('modelId') as string | null;
    const language = formData.get('language') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!audioFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Audio file is required');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const effectiveProviderId = providerId || ('openai-whisper' as ASRProviderId);
    resolvedProviderId = effectiveProviderId;
    resolvedModelId = modelId ?? undefined;

    const managed = isServerConfiguredProvider('asr', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      modelId: modelId || undefined,
      language: language || 'auto',
      apiKey: resolveASRApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
      baseUrl: resolveASRBaseUrl(effectiveProviderId, clientBaseUrl),
    };

    const result = await transcribeAudio(config, audioFile);

    return apiSuccess({ text: result.text });
  } catch (error) {
    log.error(
      `Transcription failed [provider=${resolvedProviderId ?? 'unknown'}, model=${resolvedModelId ?? 'default'}]:`,
      error,
    );
    return apiError('TRANSCRIPTION_FAILED', 500, 'Transcription failed', error instanceof Error ? error.message : 'Unknown error');
  }
});
