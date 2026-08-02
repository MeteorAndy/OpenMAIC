import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock, readFileMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

vi.mock('node:fs', () => ({
  promises: {
    readFile: readFileMock,
  },
}));

const PRIVATE_NETWORK_BLOCK_MESSAGE =
  'Local/private network URLs are not allowed. If this is a self-hosted deployment or internal gateway (including split-horizon DNS), set ALLOW_LOCAL_NETWORKS=true to allow local network targets.';
const ALLOW_LOCAL_NETWORKS_GUIDANCE = 'ALLOW_LOCAL_NETWORKS=true';
const INFRASTRUCTURE_BLOCK_MESSAGE =
  'Link-local, metadata, unspecified, and other infrastructure-sensitive addresses are not allowed.';
const originalAllowLocalNetworks = process.env.ALLOW_LOCAL_NETWORKS;
const originalDesktopRuntime = process.env.DESKTOP_RUNTIME;
const originalTrustedEndpointsFile = process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE;

describe('validateUrlForSSRF', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(new Error('allowlist unavailable'));
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.DESKTOP_RUNTIME;
    delete process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE;
  });

  afterEach(() => {
    if (originalAllowLocalNetworks === undefined) {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    } else {
      process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocalNetworks;
    }
    if (originalDesktopRuntime === undefined) delete process.env.DESKTOP_RUNTIME;
    else process.env.DESKTOP_RUNTIME = originalDesktopRuntime;
    if (originalTrustedEndpointsFile === undefined)
      delete process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE;
    else process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE = originalTrustedEndpointsFile;
  });

  it('allows a public hostname when DNS resolves to a public IP', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://api.openai.com')).resolves.toBeNull();
    expect(lookupMock).toHaveBeenCalledWith('api.openai.com', { all: true, verbatim: true });
  });

  it('allows a public IP literal without DNS lookup', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://8.8.8.8')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows a public IPv6 literal without DNS lookup', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://[2606:4700:4700::1111]')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects invalid URLs and non-http protocols', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('not-a-url')).resolves.toBe('Invalid URL');
    await expect(validateUrlForSSRF('ftp://example.com')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
    await expect(validateUrlForSSRF('file:///etc/passwd')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
    await expect(validateUrlForSSRF('javascript:alert(1)')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
  });

  it('rejects blocked hostnames immediately', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const localhostResult = await validateUrlForSSRF('http://localhost');
    expect(localhostResult).toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    expect(localhostResult).toContain(ALLOW_LOCAL_NETWORKS_GUIDANCE);
    await expect(validateUrlForSSRF('http://printer.local')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects private IPv4 literals', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const urls = [
      'http://127.0.0.1',
      'http://10.0.0.42',
      'http://172.16.5.4',
      'http://172.31.255.255',
      'http://192.168.1.10',
    ];

    for (const url of urls) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    }

    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('always rejects infrastructure-sensitive IPv4 literals', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    for (const url of [
      'http://169.254.169.254',
      'http://100.100.100.200',
      'http://0.0.0.0',
      'http://224.0.0.1',
    ]) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(INFRASTRUCTURE_BLOCK_MESSAGE);
    }
  });

  it('rejects private IPv6 literals and mapped loopback addresses', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const urls = ['http://[::1]', 'http://[fd00::1234]', 'http://[::ffff:127.0.0.1]'];

    for (const url of urls) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    }

    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('always rejects infrastructure-sensitive IPv6 literals', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    for (const url of ['http://[::]', 'http://[fe80::1]', 'http://[fec0::1]']) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(INFRASTRUCTURE_BLOCK_MESSAGE);
    }
  });

  it('detects private IPv4 embedded in expanded and compressed ISATAP addresses', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    const addresses = [
      '2001:db8:0:1:0:5efe:7f00:1',
      '2001:db8:0:1:200:5efe:a00:1',
      '2001:db8:0:1::5efe:c0a8:101',
      '2001:db8::200:5efe:ac10:1',
    ];

    for (const address of addresses) {
      expect(isPrivateIP(address)).toBe(true);
    }
  });

  it('classifies direct dotted-tail ISATAP addresses by their embedded IPv4', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2001:db8:0:1::5efe:192.168.1.1')).toBe(true);
    expect(isPrivateIP('2001:db8::200:5efe:10.0.0.1')).toBe(true);
    expect(isPrivateIP('2001:db8:0:1::5efe:8.8.8.8')).toBe(false);
  });

  it('does not match ISATAP lookalikes with invalid flags, markers, or positions', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    const addresses = [
      '2001:db8::100:5efe:127.0.0.1',
      '2001:db8::300:5efe:127.0.0.1',
      '2001:db8::beef:127.0.0.1',
      '2001:db8::5efe:0:127.0.0.1',
    ];

    for (const address of addresses) {
      expect(isPrivateIP(address)).toBe(false);
    }
  });

  it('does not classify zero-width IPv6 compression as ISATAP', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2001:db8:0:1:0:5efe::127.0.0.1')).toBe(false);
  });

  it('preserves 6to4 and Teredo classification for mixed dotted-tail notation', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2002:7f00:0001::192.0.2.1')).toBe(true);
    expect(isPrivateIP('2002:0808:0808::127.0.0.1')).toBe(false);
    expect(isPrivateIP('2001:0000:4136:e378:8000:63bf:128.255.255.254')).toBe(true);
    expect(isPrivateIP('2001:0000:4136:e378:8000:63bf:247.247.247.247')).toBe(false);
  });

  it('rejects 6to4 tunnel addresses embedding private IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // 2002:7f00:0001:: embeds 127.0.0.1
    await expect(validateUrlForSSRF('http://[2002:7f00:0001::]')).resolves.toBe(
      INFRASTRUCTURE_BLOCK_MESSAGE,
    );
    // 2002:0a00:0001:: embeds 10.0.0.1
    await expect(validateUrlForSSRF('http://[2002:0a00:0001::]')).resolves.toBe(
      INFRASTRUCTURE_BLOCK_MESSAGE,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows 6to4 tunnel addresses embedding public IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // 2002:0808:0808:: embeds 8.8.8.8
    await expect(validateUrlForSSRF('http://[2002:0808:0808::]')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects Teredo tunnel addresses embedding private IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // Client IPv4 127.0.0.1 XOR 0xFFFFFFFF = 0x80FFFFFE → hextets 80ff:fffe
    await expect(
      validateUrlForSSRF('http://[2001:0000:4136:e378:8000:63bf:80ff:fffe]'),
    ).resolves.toBe(INFRASTRUCTURE_BLOCK_MESSAGE);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows Teredo tunnel addresses embedding public IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // Client IPv4 8.8.8.8 XOR 0xFFFFFFFF = 0xF7F7F7F7 → hextets f7f7:f7f7
    await expect(
      validateUrlForSSRF('http://[2001:0000:4136:e378:8000:63bf:f7f7:f7f7]'),
    ).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to a private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const result = await validateUrlForSSRF('https://attacker.com');
    expect(result).toContain('mixed public/local');
  });

  it('rejects hostnames when any DNS answer is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://mixed.example')).resolves.toContain(
      'mixed public/local',
    );
  });

  it('rejects a hostname that resolves to an ISATAP address embedding private IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '2001:db8::200:5efe:192.168.1.10', family: 6 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://isatap.example')).resolves.toBe(
      INFRASTRUCTURE_BLOCK_MESSAGE,
    );
  });

  it('allows local network targets when ALLOW_LOCAL_NETWORKS=true', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('http://192.168.1.10')).resolves.toBeNull();
    await expect(validateUrlForSSRF('https://internal.example')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows loopback only for an explicit local provider in Desktop Edition', async () => {
    process.env.DESKTOP_RUNTIME = '1';
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(
      validateUrlForSSRF('http://127.0.0.1:11434/v1', { providerId: 'ollama' }),
    ).resolves.toBeNull();
    await expect(
      validateUrlForSSRF('http://127.0.0.1:11434/v1', { providerId: 'openai' }),
    ).resolves.toContain('not trusted');
  });

  it('requires an exact approved origin for a private LAN endpoint on Desktop', async () => {
    process.env.DESKTOP_RUNTIME = '1';
    process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE = 'trusted.json';
    readFileMock.mockResolvedValue('["http://192.168.1.20:11434"]');
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('http://192.168.1.20:11434/v1')).resolves.toBeNull();
    await expect(validateUrlForSSRF('http://192.168.1.20:8080/v1')).resolves.toContain(
      'not trusted',
    );
  });

  it('does not inherit local approval across redirects', async () => {
    process.env.DESKTOP_RUNTIME = '1';
    process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE = 'trusted.json';
    readFileMock.mockResolvedValue('["http://192.168.1.20:11434"]');
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(
      validateUrlForSSRF('http://192.168.1.20:11434/redirected', { redirect: true }),
    ).resolves.toContain('not trusted');
  });

  it('blocks mixed public/private DNS answers even for an approved Desktop origin', async () => {
    process.env.DESKTOP_RUNTIME = '1';
    process.env.DESKTOP_TRUSTED_ENDPOINTS_FILE = 'trusted.json';
    readFileMock.mockResolvedValue('["https://mixed.example:443"]');
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.20', family: 4 },
    ]);
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://mixed.example')).resolves.toContain(
      'mixed public/local',
    );
  });

  it('fails closed when DNS lookup errors', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://missing.example')).resolves.toBe(
      'Unable to verify hostname safety',
    );
  });
});
