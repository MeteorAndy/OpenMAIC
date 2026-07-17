/**
 * POST /api/generate/tts — mirrors app/api/generate/tts/route.ts.
 * HTTP layer only; generateTTS + provider-config reused unchanged.
 */
import { Hono } from 'hono';
import { generateTTS, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('TTS API');

export const generateTtsRoute = new Hono<AuthVars>();
generateTtsRoute.use('*', authMiddleware);

generateTtsRoute.post('/', async (c) => {
  let ttsProviderId: string | undefined;
  let ttsVoice: string | undefined;
  let audioId: string | undefined;
  try {
    const body = await c.req.json();
    const { text, ttsModelId, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = body as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsProviderOptions?: Record<string, unknown>;
    };
    ttsProviderId = body.ttsProviderId;
    ttsVoice = body.ttsVoice;
    audioId = body.audioId;

    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required fields: text, audioId, ttsProviderId, ttsVoice');
    }

    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    if (isServerTTSProviderDisabled(ttsProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }

    const voxcpmVoicePrompt = typeof ttsProviderOptions?.voicePrompt === 'string' ? ttsProviderOptions.voicePrompt : '';
    const voxcpmRegisteredVoiceId =
      typeof ttsProviderOptions?.registeredVoiceId === 'string' ? ttsProviderOptions.registeredVoiceId : '';
    if (
      ttsProviderId === VOXCPM_TTS_PROVIDER_ID &&
      ttsVoice === VOXCPM_AUTO_VOICE_ID &&
      !voxcpmVoicePrompt.trim() &&
      !voxcpmRegisteredVoiceId.trim()
    ) {
      return apiError('VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT', 400, 'VoxCPM Auto Voice requires agent context');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const managed = isServerConfiguredProvider('tts', ttsProviderId);
    const clientBaseUrl = managed ? undefined : ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(ttsProviderId, clientBaseUrl);

    const config = {
      providerId: ttsProviderId as TTSProviderId,
      modelId: resolveTTSModel(ttsProviderId, ttsModelId),
      voice: ttsVoice,
      speed: ttsSpeed ?? 1.0,
      apiKey,
      baseUrl,
      providerOptions: ttsProviderOptions,
    };

    log.info(
      `Generating TTS: provider=${ttsProviderId}, model=${config.modelId || 'default'}, voice=${ttsVoice}, ` +
        `registeredVoiceId=${voxcpmRegisteredVoiceId || 'none'}, audioId=${audioId}, textLen=${text.length}`,
    );

    const { audio, format } = await generateTTS(config, text);

    void recordGenerationUsage({
      kind: 'tts',
      unit: 'character',
      providerId: ttsProviderId,
      modelId: config.modelId,
      quantity: text.length,
    });

    const base64 = Buffer.from(audio).toString('base64');

    return apiSuccess({ audioId, base64, format });
  } catch (error) {
    log.error(
      `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
      error,
    );
    if (error instanceof TTSRateLimitError) {
      return apiError('RATE_LIMITED', 429, error.message);
    }
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
});
