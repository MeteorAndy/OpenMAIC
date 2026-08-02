import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:47823';

function request(
  path: string,
  options: { method?: string; host?: string; origin?: string; token?: string } = {},
): NextRequest {
  const headers = new Headers({ host: options.host ?? '127.0.0.1:47823' });
  if (options.origin) headers.set('origin', options.origin);
  if (options.token) headers.set('cookie', `openmaic_desktop=${options.token}`);
  return new NextRequest(`${ORIGIN}${path}`, { method: options.method, headers });
}

describe('desktop middleware', () => {
  beforeEach(() => {
    process.env.DESKTOP_RUNTIME = '1';
    process.env.DESKTOP_SERVICE_ORIGIN = ORIGIN;
    process.env.DESKTOP_AUTH_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.DESKTOP_RUNTIME;
    delete process.env.DESKTOP_SERVICE_ORIGIN;
    delete process.env.DESKTOP_AUTH_TOKEN;
  });

  it('keeps only the minimal health route anonymous on the fixed host', async () => {
    expect((await middleware(request('/api/health'))).status).toBe(200);
    expect((await middleware(request('/'))).status).toBe(401);
    expect((await middleware(request('/api/health', { host: 'localhost:47823' }))).status).toBe(
      421,
    );
  });

  it('requires the exact desktop session cookie', async () => {
    expect((await middleware(request('/', { token: TOKEN }))).status).toBe(200);
    expect((await middleware(request('/', { token: `${TOKEN}0` }))).status).toBe(401);
    expect((await middleware(request('/', { token: 'b'.repeat(64) }))).status).toBe(401);
  });

  it('requires the desktop origin on every state-changing request', async () => {
    expect(
      (await middleware(request('/api/chat', { method: 'POST', origin: ORIGIN, token: TOKEN })))
        .status,
    ).toBe(200);
    expect((await middleware(request('/api/chat', { method: 'POST', token: TOKEN }))).status).toBe(
      403,
    );
    expect(
      (
        await middleware(
          request('/api/chat', {
            method: 'POST',
            origin: 'https://attacker.example',
            token: TOKEN,
          }),
        )
      ).status,
    ).toBe(403);
  });
});
