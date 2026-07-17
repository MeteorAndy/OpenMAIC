/**
 * POST /api/verify-pdf-provider — mirrors app/api/verify-pdf-provider/route.ts. Public.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isServerConfiguredProvider, resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { MINERU_CLOUD_DEFAULT_BASE } from '@/lib/pdf/constants';

const log = createLogger('Verify PDF Provider');

export const verifyPdfProviderRoute = new Hono();

verifyPdfProviderRoute.post('/', async (c) => {
  let providerId: string | undefined;
  try {
    const body = await c.req.json();
    providerId = body.providerId;
    const { apiKey, baseUrl } = body;

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    const managed = isServerConfiguredProvider('pdf', providerId);

    if (providerId === 'mineru-cloud') {
      const clientCloudBase = managed ? undefined : (baseUrl as string | undefined) || undefined;
      if (clientCloudBase && process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(clientCloudBase);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }

      const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);
      if (!resolvedApiKey) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'API Key is required for MinerU Cloud');
      }

      const cloudBase = (resolvePDFBaseUrl(providerId, clientCloudBase) || MINERU_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');

      const response = await fetch(`${cloudBase}/extract-results/batch/test-connection`, {
        headers: { Authorization: `Bearer ${resolvedApiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => '');
        return apiError('INTERNAL_ERROR', 500, `Authentication failed: ${text || response.statusText}`);
      }

      return apiSuccess({ message: 'Connection successful', status: response.status });
    }

    const clientBaseUrl = managed ? undefined : (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedBaseUrl = resolvePDFBaseUrl(providerId, clientBaseUrl);
    if (!resolvedBaseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);

    const headers: Record<string, string> = {};
    if (resolvedApiKey) {
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    const response = await fetch(resolvedBaseUrl, { headers, signal: AbortSignal.timeout(10000), redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    return apiSuccess({ message: 'Connection successful', status: response.status });
  } catch (error) {
    log.error(`PDF provider verification failed [provider=${providerId ?? 'unknown'}]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to server, please check the Base URL';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = 'Server not found, please check the Base URL';
      } else if (error.message.includes('timeout') || error.name === 'TimeoutError') {
        errorMessage = 'Connection timed out';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
});
