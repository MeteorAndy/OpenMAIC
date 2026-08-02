import type { PersistStorage, StorageValue } from 'zustand/middleware';

import { createLogger } from '@/lib/logger';
import { createKVPersistStorage, type KVPersistDeps } from '@/lib/store/kv-persist';
import type { KVScope } from '@openmaic/storage';
import { getTauriInvoke } from '@/lib/desktop/runtime';

const log = createLogger('DesktopCredentials');
const CREDENTIAL_FIELDS = new Set(['apiKey', 'accessKeyId', 'accessKeySecret']);

interface CredentialSlot {
  path: string[];
  value: string;
}

function stripCredentials(
  value: unknown,
  path: string[] = [],
  slots: CredentialSlot[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => stripCredentials(entry, [...path, String(index)], slots));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const fieldPath = [...path, key];
      if (CREDENTIAL_FIELDS.has(key) && typeof entry === 'string') {
        slots.push({ path: fieldPath, value: entry });
        return [key, ''];
      }
      return [key, stripCredentials(entry, fieldPath, slots)];
    }),
  );
}

function credentialId(storeName: string, path: string[]): string {
  return `${storeName}/${path.map(encodeURIComponent).join('/')}`;
}

function setAtPath(root: unknown, path: string[], value: string): void {
  let target = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = target[key];
    if (!next || typeof next !== 'object') return;
    target = next as Record<string, unknown>;
  }
  const field = path.at(-1);
  if (field) target[field] = value;
}

function scheduleRecovery(callback: KVPersistDeps['onWriteRefused'], name: string): void {
  if (!callback) return;
  setTimeout(() => {
    void Promise.resolve(callback(name)).catch((error) => {
      log.error('Credential recovery failed:', error);
    });
  }, 0);
}

/**
 * Removes provider secrets from the persisted settings blob in Desktop Edition.
 * The returned in-memory value is rehydrated from Windows Credential Manager.
 */
export function wrapDesktopCredentialStorage<S>(
  base: PersistStorage<S>,
  onWriteRefused?: KVPersistDeps['onWriteRefused'],
): PersistStorage<S> {
  const knownCredentials = new Map<string, string>();
  let vaultReadable = false;

  return {
    async getItem(name) {
      const stored = await base.getItem(name);
      const invoke = getTauriInvoke();
      if (!stored || !invoke) return stored;

      const slots: CredentialSlot[] = [];
      const sanitized = stripCredentials(stored, [], slots) as StorageValue<S>;
      const plaintext = slots.filter((slot) => slot.value.length > 0);

      if (plaintext.length > 0) {
        try {
          for (const slot of plaintext) {
            await invoke('set_provider_credential', {
              id: credentialId(name, slot.path),
              value: slot.value,
            });
          }
          await base.setItem(name, sanitized);
        } catch (error) {
          log.error('Could not migrate plaintext provider credentials:', error);
          return sanitized;
        }
      }

      try {
        for (const slot of slots) {
          const id = credentialId(name, slot.path);
          const value = (await invoke<string | null>('get_provider_credential', { id })) ?? '';
          knownCredentials.set(id, value);
          setAtPath(sanitized, slot.path, value);
        }
        vaultReadable = true;
        return sanitized;
      } catch (error) {
        vaultReadable = false;
        knownCredentials.clear();
        log.error('Windows Credential Manager is unavailable:', error);
        return sanitized;
      }
    },

    async setItem(name, value) {
      const invoke = getTauriInvoke();
      if (!invoke) return base.setItem(name, value);

      const slots: CredentialSlot[] = [];
      const sanitized = stripCredentials(value, [], slots) as StorageValue<S>;
      try {
        for (const slot of slots) {
          const id = credentialId(name, slot.path);
          const previous = knownCredentials.get(id);
          if (slot.value) {
            if (slot.value !== previous) {
              await invoke('set_provider_credential', { id, value: slot.value });
            }
            knownCredentials.set(id, slot.value);
          } else if (vaultReadable && previous) {
            await invoke('delete_provider_credential', { id });
            knownCredentials.set(id, '');
          }
        }
      } catch (error) {
        vaultReadable = false;
        log.error('Could not protect provider credentials:', error);
        scheduleRecovery(onWriteRefused, name);
        throw error;
      }
      return base.setItem(name, sanitized);
    },

    async removeItem(name) {
      const invoke = getTauriInvoke();
      if (invoke) {
        for (const [id, value] of knownCredentials) {
          if (value) await invoke('delete_provider_credential', { id });
        }
        knownCredentials.clear();
      }
      return base.removeItem(name);
    },
  };
}

export function createDesktopCredentialPersistStorage<S>(
  scope: KVScope,
  deps: KVPersistDeps = {},
): PersistStorage<S> {
  return wrapDesktopCredentialStorage(createKVPersistStorage<S>(scope, deps), deps.onWriteRefused);
}
