import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_COMPATIBILITY_KEY,
  WORKSPACE_COMPATIBILITY_VERSION,
} from '@/lib/backup/db-backup';
import { inspectWorkspaceCompatibility } from '@/lib/backup/workspace-compatibility';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length() {
    return this.#values.size;
  }
  clear() {
    this.#values.clear();
  }
  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#values.delete(key);
  }
  setItem(key: string, value: string) {
    this.#values.set(key, String(value));
  }
}

function database(): Dexie {
  const db = new Dexie('workspace-compatibility-test', {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  db.version(3).stores({ notes: 'id' });
  return db;
}

describe('workspace compatibility gate', () => {
  it('allows a new workspace and compatible recorded metadata', () => {
    const db = database();
    const storage = new MemoryStorage();
    expect(inspectWorkspaceCompatibility(db, storage).state).toBe('compatible');
    storage.setItem(
      WORKSPACE_COMPATIBILITY_KEY,
      JSON.stringify({
        version: WORKSPACE_COMPATIBILITY_VERSION,
        schemaVersion: 3,
        minimumReaderSchemaVersion: 3,
        desktopVersion: '0.1.0',
        recordedAt: new Date().toISOString(),
      }),
    );
    expect(inspectWorkspaceCompatibility(db, storage).state).toBe('compatible');
    db.close();
  });

  it('blocks downgrade and corrupted metadata without opening the database', () => {
    const db = database();
    const storage = new MemoryStorage();
    storage.setItem(
      WORKSPACE_COMPATIBILITY_KEY,
      JSON.stringify({
        version: WORKSPACE_COMPATIBILITY_VERSION,
        schemaVersion: 4,
        minimumReaderSchemaVersion: 4,
        desktopVersion: '0.2.0',
        recordedAt: new Date().toISOString(),
      }),
    );
    expect(inspectWorkspaceCompatibility(db, storage)).toMatchObject({ state: 'blocked' });
    storage.setItem(WORKSPACE_COMPATIBILITY_KEY, '{broken');
    expect(inspectWorkspaceCompatibility(db, storage)).toMatchObject({ state: 'blocked' });
    expect(db.isOpen()).toBe(false);
    db.close();
  });
});
