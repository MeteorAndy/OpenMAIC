/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */
import { promises as dns } from 'node:dns';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';

function normalizeAddress(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, '');
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });

  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function extractMappedIPv4(ip: string): string | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.startsWith('::ffff:')) {
    return null;
  }

  const suffix = normalized.slice('::ffff:'.length);
  const dottedIPv4 = parseIPv4(suffix);
  if (dottedIPv4) {
    return dottedIPv4.join('.');
  }

  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  const [high, low] = parts.map((part) => Number.parseInt(part, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function getFirstIPv6Hextet(ip: string): number | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) {
    return null;
  }

  if (normalized.startsWith('::')) {
    return 0;
  }

  const [firstHextet] = normalized.split(':');
  if (!firstHextet || !/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return null;
  }

  return Number.parseInt(firstHextet, 16);
}

/** Expand an IPv6 address into 8 numeric hextets. Returns null for invalid input. */
function expandIPv6(ip: string): number[] | null {
  let normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) return null;

  const lastPart = normalized.split(':').pop() || '';
  if (lastPart.includes('.')) {
    const dottedIPv4 = parseIPv4(lastPart);
    if (!dottedIPv4) return null;

    const [first, second, third, fourth] = dottedIPv4;
    const high = ((first << 8) | second).toString(16);
    const low = ((third << 8) | fourth).toString(16);
    normalized = `${normalized.slice(0, -lastPart.length)}${high}:${low}`;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) return null;

  let parts: string[];
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing <= 0) return null;
    parts = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    parts = normalized.split(':');
  }

  if (parts.length !== 8) return null;
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;

  return parts.map((p) => Number.parseInt(p, 16));
}

export function isPrivateIP(ip: string): boolean {
  const normalized = normalizeAddress(ip);
  const mappedIPv4 = extractMappedIPv4(normalized);
  if (mappedIPv4) {
    return isPrivateIP(mappedIPv4);
  }

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [first, second, third, fourth] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 0 && second === 0 && third === 0 && fourth === 0)
    );
  }

  const ipv6FirstHextet = getFirstIPv6Hextet(normalized);
  if (ipv6FirstHextet === null) {
    return false;
  }

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (
    (ipv6FirstHextet & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (ipv6FirstHextet & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (ipv6FirstHextet & 0xffc0) === 0xfec0 // fec0::/10 site-local (deprecated)
  ) {
    return true;
  }

  // 6to4 tunnel: 2002::/16 — embedded IPv4 sits in bits 16-47
  if (ipv6FirstHextet === 0x2002) {
    const hextets = expandIPv6(normalized);
    if (hextets) {
      const embedded = `${hextets[1] >> 8}.${hextets[1] & 0xff}.${hextets[2] >> 8}.${hextets[2] & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  // Teredo tunnel: 2001:0000::/32 — client IPv4 in last 32 bits, XOR-inverted
  if (ipv6FirstHextet === 0x2001) {
    const hextets = expandIPv6(normalized);
    if (hextets && hextets[1] === 0x0000) {
      const high = hextets[6] ^ 0xffff;
      const low = hextets[7] ^ 0xffff;
      const embedded = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  // ISATAP interface ID: 0000:5efe:<IPv4> or 0200:5efe:<IPv4>
  const hextets = expandIPv6(normalized);
  if (hextets && (hextets[4] === 0x0000 || hextets[4] === 0x0200) && hextets[5] === 0x5efe) {
    const embedded = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
    if (isPrivateIP(embedded)) return true;
  }

  return false;
}

const LOCAL_NETWORK_BLOCK_MESSAGE =
  'Local/private network URLs are not allowed. If this is a self-hosted deployment or internal gateway (including split-horizon DNS), set ALLOW_LOCAL_NETWORKS=true to allow local network targets.';

const DESKTOP_LOCAL_NETWORK_BLOCK_MESSAGE =
  'This local provider endpoint is not trusted. Loopback requires a built-in local provider; private LAN endpoints require explicit approval in Desktop settings.';
const INFRASTRUCTURE_BLOCK_MESSAGE =
  'Link-local, metadata, unspecified, and other infrastructure-sensitive addresses are not allowed.';
const DNS_REBINDING_BLOCK_MESSAGE =
  'The hostname resolved to a mixed public/local address set and was blocked.';

const EXPLICIT_LOCAL_PROVIDER_IDS = new Set([
  'ollama',
  'lemonade',
  'comfyui-image',
  'voxcpm-tts',
  'lemonade-tts',
  'lemonade-asr',
]);

type AddressClass = 'public' | 'loopback' | 'private-lan' | 'infrastructure';

export interface SSRFValidationContext {
  providerId?: string;
  /** Redirect targets never inherit local-provider or user-approved LAN access. */
  redirect?: boolean;
}

function classifyAddress(address: string): AddressClass {
  const normalized = normalizeAddress(address);
  const mapped = extractMappedIPv4(normalized);
  if (mapped) return classifyAddress(mapped);

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [first, second] = ipv4;
    if (first === 127) return 'loopback';
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return 'private-lan';
    }
    if (
      first === 0 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      first >= 224
    ) {
      return 'infrastructure';
    }
    return 'public';
  }

  if (normalized === '::1') return 'loopback';
  if (normalized === '::') return 'infrastructure';
  const firstHextet = getFirstIPv6Hextet(normalized);
  if (firstHextet === null) return 'public';
  if ((firstHextet & 0xfe00) === 0xfc00) return 'private-lan';
  if (
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xffc0) === 0xfec0 ||
    isPrivateIP(normalized)
  ) {
    return 'infrastructure';
  }
  return 'public';
}

function normalizedOrigin(url: URL): string {
  const defaultPort = url.protocol === 'http:' ? '80' : '443';
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || defaultPort}`;
}

async function isTrustedDesktopEndpoint(url: URL): Promise<boolean> {
  const file = process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE;
  if (!file) return false;
  try {
    const contents = await fs.readFile(file, 'utf8');
    if (contents.length > 64 * 1024) return false;
    const endpoints: unknown = JSON.parse(contents);
    return (
      Array.isArray(endpoints) &&
      endpoints.length <= 256 &&
      endpoints.every((entry) => typeof entry === 'string') &&
      endpoints.includes(normalizedOrigin(url))
    );
  } catch {
    return false;
  }
}

async function localAddressAllowed(
  classification: AddressClass,
  url: URL,
  context: SSRFValidationContext,
): Promise<boolean> {
  if (context.redirect) return false;
  const desktop = process.env.DESKTOP_RUNTIME === '1';
  if (classification === 'loopback') {
    return desktop
      ? !!context.providerId && EXPLICIT_LOCAL_PROVIDER_IDS.has(context.providerId)
      : ['true', '1'].includes(process.env.ALLOW_LOCAL_NETWORKS ?? '');
  }
  if (classification === 'private-lan') {
    return desktop
      ? await isTrustedDesktopEndpoint(url)
      : ['true', '1'].includes(process.env.ALLOW_LOCAL_NETWORKS ?? '');
  }
  return classification === 'public';
}

/**
 * Validate a URL against SSRF attacks.
 * Returns null if the URL is safe, or an error message string if blocked.
 */
export async function validateUrlForSSRF(
  url: string,
  context: SSRFValidationContext = {},
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }
  if (parsed.username || parsed.password) {
    return 'URLs with embedded credentials are not allowed';
  }

  const hostname = normalizeAddress(parsed.hostname);
  if (['metadata', 'metadata.google.internal', 'instance-data'].includes(hostname)) {
    return INFRASTRUCTURE_BLOCK_MESSAGE;
  }

  if (isIP(hostname)) {
    const classification = classifyAddress(hostname);
    if (classification === 'infrastructure') return INFRASTRUCTURE_BLOCK_MESSAGE;
    return (await localAddressAllowed(classification, parsed, context))
      ? null
      : process.env.DESKTOP_RUNTIME === '1'
        ? DESKTOP_LOCAL_NETWORK_BLOCK_MESSAGE
        : LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  if (hostname === 'localhost') {
    return (await localAddressAllowed('loopback', parsed, context))
      ? null
      : process.env.DESKTOP_RUNTIME === '1'
        ? DESKTOP_LOCAL_NETWORK_BLOCK_MESSAGE
        : LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  if (hostname.endsWith('.local')) {
    return (await localAddressAllowed('private-lan', parsed, context))
      ? null
      : process.env.DESKTOP_RUNTIME === '1'
        ? DESKTOP_LOCAL_NETWORK_BLOCK_MESSAGE
        : LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  if (
    process.env.DESKTOP_RUNTIME !== '1' &&
    !context.redirect &&
    ['true', '1'].includes(process.env.ALLOW_LOCAL_NETWORKS ?? '')
  ) {
    return null;
  }

  let resolvedAddresses: Array<{ address: string; family: number }>;
  try {
    resolvedAddresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return 'Unable to verify hostname safety';
  }

  if (resolvedAddresses.length === 0) {
    return 'Unable to verify hostname safety';
  }

  const classes = new Set(resolvedAddresses.map(({ address }) => classifyAddress(address)));
  if (classes.has('infrastructure')) return INFRASTRUCTURE_BLOCK_MESSAGE;
  if (classes.size > 1) return DNS_REBINDING_BLOCK_MESSAGE;

  const classification = classes.values().next().value as AddressClass;
  if (classification === 'loopback') {
    // Only the literal localhost name can use the local-provider exception.
    return DNS_REBINDING_BLOCK_MESSAGE;
  }
  return (await localAddressAllowed(classification, parsed, context))
    ? null
    : process.env.DESKTOP_RUNTIME === '1'
      ? DESKTOP_LOCAL_NETWORK_BLOCK_MESSAGE
      : LOCAL_NETWORK_BLOCK_MESSAGE;
}
