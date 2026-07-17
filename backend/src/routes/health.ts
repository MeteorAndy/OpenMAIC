/**
 * GET /api/health — public capability probe. Mirrors app/api/health/route.ts.
 * Reuses lib/server/api-response (apiSuccess envelope) + provider-config unchanged.
 */
import { Hono } from 'hono';
import { apiSuccess } from '@/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';

const version = process.env.BACKEND_VERSION || process.env.npm_package_version || '0.1.0';

export const health = new Hono();

health.get('/', (c) => {
  const body = apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      webSearch: Object.keys(getServerWebSearchProviders()).length > 0,
      imageGeneration: Object.keys(getServerImageProviders()).length > 0,
      videoGeneration: Object.keys(getServerVideoProviders()).length > 0,
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
  });
  // apiSuccess returns a NextResponse (Web Response subclass) — pass through unchanged.
  return body;
});
