/**
 * POST /api/generate/voice — mirrors app/api/generate/voice/route.ts.
 * HTTP layer only; voice-registration + provider-config reused unchanged.
 */
import { Hono } from 'hono';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import { getVoiceRegistrationAdapter, type VoiceRegistrationConfig } from '@/lib/audio/voice-registration';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('Voice Registration API');

export const generateVoiceRoute = new Hono<AuthVars>();
generateVoiceRoute.use('*', authMiddleware);

generateVoiceRoute.post('/', async (c) => {
  let providerId: string | undefined;
  let voiceId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      providerId?: string;
      voiceId?: string;
      descriptor?: unknown;
      language?: string;
      referenceAudioBase64?: string;
      mimeType?: string;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsModelId?: string;
    };
    providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
    voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined;
    const design = normalizeVoiceDesign(body.descriptor);

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'providerId is required');
    }
    if (!voiceId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'voiceId is required');
    }
    if (!design && !body.referenceAudioBase64) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'descriptor or referenceAudioBase64 is required');
    }

    if (isServerTTSProviderDisabled(providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }

    const adapter = getVoiceRegistrationAdapter(providerId);
    if (!adapter) {
      return apiError('INVALID_REQUEST', 400, `Provider "${providerId}" does not support voice registration`);
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const managed = isServerConfiguredProvider('tts', providerId);
    const clientBaseUrl = managed ? undefined : body.ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(providerId, managed ? undefined : body.ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(providerId, clientBaseUrl);
    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'TTS base URL is required');
    }

    const cfg: VoiceRegistrationConfig = {
      baseUrl,
      apiKey,
      model: resolveTTSModel(providerId, body.ttsModelId),
    };

    if (await adapter.voiceExists(cfg, voiceId)) {
      return apiSuccess({ voiceId, registered: true });
    }

    if (body.referenceAudioBase64) {
      await adapter.registerVoice(cfg, {
        voiceId,
        referenceAudioBase64: body.referenceAudioBase64,
        mimeType: body.mimeType,
      });
      return apiSuccess({ voiceId, registered: true });
    }

    const clip = await adapter.bootstrapReferenceClip(cfg, { design: design!, language: body.language });
    await adapter.registerVoice(cfg, {
      voiceId,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });

    log.info(`Registered auto voice ${voiceId} for provider ${providerId}`);
    return apiSuccess({
      voiceId,
      registered: true,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });
  } catch (error) {
    log.error(`Voice registration failed [provider=${providerId ?? 'unknown'}, voiceId=${voiceId ?? 'unknown'}]:`, error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
});
