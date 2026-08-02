import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

import { wrapDesktopCredentialStorage } from '@/lib/store/desktop-credential-persist';
import type { TauriGlobal } from '@/lib/desktop/runtime';

interface TestState {
  providersConfig: Record<string, { apiKey: string; baseUrl: string }>;
}

function value(apiKey: string): StorageValue<TestState> {
  return {
    state: { providersConfig: { openai: { apiKey, baseUrl: 'https://api.openai.com/v1' } } },
    version: 1,
  };
}

function createInvoke(
  implementation: (command: string, args?: Record<string, unknown>) => unknown | Promise<unknown>,
): TauriGlobal['core']['invoke'] {
  return async <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    (await implementation(command, args)) as T;
}

function memoryStorage(initial: StorageValue<TestState>): {
  storage: PersistStorage<TestState>;
  current: () => StorageValue<TestState>;
  events: string[];
} {
  let current = structuredClone(initial);
  const events: string[] = [];
  return {
    events,
    current: () => current,
    storage: {
      async getItem() {
        return structuredClone(current);
      },
      async setItem(_name, next) {
        events.push('persist');
        current = structuredClone(next);
      },
      async removeItem() {
        events.push('remove');
      },
    },
  };
}

describe('desktop credential persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI__: { core: { invoke: createInvoke(() => undefined) } } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.restoreAllMocks();
  });

  it('protects every legacy plaintext value before clearing it from KV storage', async () => {
    const memory = memoryStorage(value('legacy-secret'));
    const vault = new Map<string, string>();
    window.__TAURI__!.core.invoke = createInvoke(async (command, args) => {
      const id = String(args?.id);
      if (command === 'set_provider_credential') {
        memory.events.push('protect');
        vault.set(id, String(args?.value));
        return undefined;
      }
      if (command === 'get_provider_credential') return vault.get(id) ?? null;
      return undefined;
    });

    const storage = wrapDesktopCredentialStorage(memory.storage);
    const hydrated = await storage.getItem('settings-storage');

    expect(memory.events).toEqual(['protect', 'persist']);
    expect(memory.current().state.providersConfig.openai.apiKey).toBe('');
    expect(hydrated?.state.providersConfig.openai.apiKey).toBe('legacy-secret');
  });

  it('returns no credentials and retains plaintext when secure migration fails', async () => {
    const memory = memoryStorage(value('legacy-secret'));
    window.__TAURI__!.core.invoke = createInvoke(async (command) => {
      if (command === 'set_provider_credential') throw new Error('vault unavailable');
      return null;
    });

    const storage = wrapDesktopCredentialStorage(memory.storage);
    const hydrated = await storage.getItem('settings-storage');

    expect(memory.current().state.providersConfig.openai.apiKey).toBe('legacy-secret');
    expect(hydrated?.state.providersConfig.openai.apiKey).toBe('');
    expect(memory.events).toEqual([]);
  });

  it('never writes a newly entered credential to KV storage', async () => {
    const memory = memoryStorage(value(''));
    const vault = new Map<string, string>();
    window.__TAURI__!.core.invoke = createInvoke(async (command, args) => {
      const id = String(args?.id);
      if (command === 'get_provider_credential') return vault.get(id) ?? null;
      if (command === 'set_provider_credential') vault.set(id, String(args?.value));
      return undefined;
    });

    const storage = wrapDesktopCredentialStorage(memory.storage);
    await storage.getItem('settings-storage');
    await storage.setItem('settings-storage', value('new-secret'));

    expect([...vault.values()]).toContain('new-secret');
    expect(memory.current().state.providersConfig.openai.apiKey).toBe('');
  });
});
