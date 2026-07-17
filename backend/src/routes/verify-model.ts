/**
 * POST /api/verify-model — mirrors app/api/verify-model/route.ts. Public.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModel } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';

const log = createLogger('Verify Model');

export const verifyModelRoute = new Hono();

verifyModelRoute.post('/', async (c) => {
  let model: string | undefined;
  try {
    const body = await c.req.json();
    const { apiKey, baseUrl, providerType } = body;
    model = body.model;

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    let languageModel;
    try {
      const result = await resolveModel({ modelString: model, apiKey: apiKey || '', baseUrl: baseUrl || undefined, providerType });
      languageModel = result.model;
    } catch (error) {
      return apiError('INVALID_REQUEST', 401, error instanceof Error ? error.message : String(error));
    }

    const { text } = await callLLM(
      { model: languageModel, prompt: 'Say "OK" if you can hear me.', maxOutputTokens: 64 },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );

    return apiSuccess({ message: 'Connection successful', response: text });
  } catch (error) {
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API key is invalid or expired';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage = 'Model not found or API endpoint error';
      } else if (error.message.includes('429')) {
        errorMessage = 'API rate limit exceeded, please try again later';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to API server, please check the Base URL';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Connection timed out, please check your network';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
});
