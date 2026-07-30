/**
 * Seedream (ByteDance / Doubao / Ark) Image Generation Adapter
 *
 * Uses OpenAI-compatible synchronous API format.
 * Endpoint: https://ark.cn-beijing.volces.com/api/v3/images/generations
 *
 * Supported models:
 * - doubao-seedream-5-0-260128  (latest / Lite, text2img + img2img + multi-ref + group)
 * - doubao-seedream-5-0-lite-260128  (explicit Lite alias)
 * - doubao-seedream-4-5-251128
 * - doubao-seedream-4-0-250828
 * - doubao-seedream-3-0-t2i-250415
 *
 * API docs: https://www.volcengine.com/docs/6791/1399028
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { probeAuth } from '../probe-auth';

const DEFAULT_MODEL = 'doubao-seedream-5-0-260128';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com';

/**
 * Resolves the Ark API root. A bare host (e.g. the default
 * `https://ark.cn-beijing.volces.com`) gets the standard `/api/v3` appended; a
 * baseUrl that already carries an `/api/...` path (e.g. a token plan's
 * `https://ark.cn-beijing.volces.com/api/plan/v3`) is used verbatim. Trailing
 * slashes are trimmed.
 */
function resolveArkRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/api\//.test(trimmed) ? trimmed : `${trimmed}/api/v3`;
}

const SEEDREAM_MIN_PIXELS = 3_686_400;
const SEEDREAM_MAX_PIXELS = 4_624_220; // Seedream 5.0 Pro area hard cap (400 error)

/**
 * Map our aspect ratio + size to Seedream "WxH". Seedream 5.0 Pro rejects area
 * outside [3,686,400, 4,624,220] px (HTTP 400 "image area must be at most
 * 4624220 pixels" — account-level cap; official 3K/4K docs exceed it, so clamp
 * to the value the API actually enforces). Scale the requested aspect ratio
 * into that window; floor h then w so w*h stays under the cap
 * (h^2*ratio <= target => w*h <= target).
 */
function resolveSeedreamSize(options: ImageGenerationOptions): string {
  if (options.width && options.height) {
    const ratio = options.width / options.height;
    const pixels = options.width * options.height;
    if (pixels >= SEEDREAM_MIN_PIXELS && pixels <= SEEDREAM_MAX_PIXELS) {
      return `${options.width}x${options.height}`;
    }
    // Scale to the MAX end of the window (near official 2K quality, and stays
    // inside [MIN, MAX] after flooring — a MIN target dropped 9:16/4:3 below
    // the lower bound). Floor h then w keeps w*h <= MAX.
    const target = SEEDREAM_MAX_PIXELS;
    const h = Math.floor(Math.sqrt(target / ratio));
    const w = Math.floor(h * ratio);
    return `${w}x${h}`;
  }
  // Default to 2K for quality
  return '2K';
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testSeedreamConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  return probeAuth({
    providerName: 'Seedream',
    request: () =>
      fetch(`${resolveArkRoot(baseUrl)}/images/generations`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          prompt: '',
          size: '1x1',
        }),
      }),
  });
}

export async function generateWithSeedream(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const response = await fetch(`${resolveArkRoot(baseUrl)}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      prompt: options.prompt,
      size: resolveSeedreamSize(options),
      watermark: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Seedream generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, b64_json, ... }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('Seedream returned empty response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
