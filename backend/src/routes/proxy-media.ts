/**
 * POST /api/proxy-media — mirrors app/_api_archive/proxy-media/route.ts. Public.
 * Returns the upstream blob as a Response (Hono passes it through unchanged).
 */
import { Hono } from 'hono';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyMedia');

export const proxyMediaRoute = new Hono();

proxyMediaRoute.post('/', async (c) => {
  let url: string | undefined;
  try {
    ({ url } = await c.req.json());

    if (!url || typeof url !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing or invalid url');
    }

    const ssrfError = await validateUrlForSSRF(url);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response: Response;
    for (let hop = 0; ; hop++) {
      response = await fetch(currentUrl, { redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) return apiError('UPSTREAM_ERROR', 502, 'Redirect response without Location header');
      if (hop >= MAX_REDIRECTS) return apiError('TOO_MANY_REDIRECTS', 502, 'Too many redirects');
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        return apiError('INVALID_URL', 502, 'Invalid redirect Location');
      }
      const hopError = await validateUrlForSSRF(nextUrl);
      if (hopError) return apiError('INVALID_URL', 403, hopError);
      currentUrl = nextUrl;
    }

    if (!response!.ok) {
      const status = response!.status >= 400 && response!.status < 500 ? response!.status : 502;
      return apiError('UPSTREAM_ERROR', status, `Upstream returned ${response!.status}`);
    }

    const MAX_PROXY_BYTES = 25 * 1024 * 1024;
    const contentLength = Number(response!.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BYTES) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${contentLength} bytes)`);
    }
    const blob = await response!.blob();
    if (blob.size > MAX_PROXY_BYTES) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${blob.size} bytes)`);
    }
    const contentType = response!.headers.get('content-type') || 'application/octet-stream';

    return new Response(blob, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    log.error(`Proxy media failed [url="${url?.substring(0, 100) ?? 'unknown'}"]:`, error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
});
