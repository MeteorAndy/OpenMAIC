import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  exportDatabase: vi.fn(),
  importDatabase: vi.fn(),
  replaceDatabase: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => databaseMocks);

import {
  BACKUP_FORMAT_VERSION,
  RecoveryModeRequiredError,
  WORKSPACE_COMPATIBILITY_KEY,
  exportAllTables,
  importAllTables,
} from '@/lib/backup/db-backup';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, String(value));
  }
}

const authoritativeDatabase = {
  documents: [{ stage: { id: 'stage-1', name: 'Saved course' }, scenes: [] }],
  chatSessions: [],
  playbackState: [],
};

let db: Dexie | undefined;

type MutableBackupRow = Record<string, unknown> & {
  blob?: { __blob: string; size: number };
};

interface MutableBackupManifest {
  counts: Record<string, number>;
  tables: Record<string, MutableBackupRow[]>;
}

function createDatabase(schema: Record<string, string>): Dexie {
  const instance = new Dexie(`maic-backup-test-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  });
  instance.version(1).stores(schema);
  db = instance;
  return instance;
}

async function mutateArchive(
  snapshot: Blob,
  mutate: (zip: JSZip, manifest: MutableBackupManifest) => void,
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
  const manifest = JSON.parse(
    await zip.file('backup.json')!.async('string'),
  ) as MutableBackupManifest;
  mutate(zip, manifest);
  zip.file('backup.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'arraybuffer' });
}

beforeEach(() => {
  databaseMocks.exportDatabase.mockResolvedValue(authoritativeDatabase);
  databaseMocks.replaceDatabase.mockResolvedValue(undefined);
});

afterEach(() => {
  db?.close();
  db = undefined;
  vi.clearAllMocks();
});

describe('database backup', () => {
  it('exports non-sensitive settings and restores by replacing the complete workspace', async () => {
    const activeDb = createDatabase({ notes: 'id' });
    const storage = new MemoryStorage();
    storage.setItem('theme', 'dark');
    storage.setItem(
      'maic:account:settings-storage',
      JSON.stringify({
        state: {
          providersConfig: {
            openai: { apiKey: 'must-not-leak', baseUrl: 'https://api.openai.com/v1' },
          },
          nested: [{ accessKeyId: 'also-secret', label: 'keep-me' }],
        },
      }),
    );
    storage.setItem('apiKey', 'top-level-secret');
    await activeDb.table('notes').put({ id: 'note-1', text: 'snapshot row' });

    const snapshot = await exportAllTables(activeDb, { storage });
    const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const manifest = JSON.parse(await zip.file('backup.json')!.async('string'));
    expect(manifest.format).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.database).toEqual(authoritativeDatabase);
    expect(manifest.localStorage.theme).toBe('dark');
    expect(manifest.localStorage.apiKey).toBeUndefined();
    expect(manifest.localStorage[WORKSPACE_COMPATIBILITY_KEY]).toBeTypeOf('string');
    const settings = JSON.parse(manifest.localStorage['maic:account:settings-storage']);
    expect(settings.state.providersConfig.openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(settings.state.nested).toEqual([{ label: 'keep-me' }]);

    await activeDb.table('notes').clear();
    await activeDb.table('notes').put({ id: 'stale-note', text: 'must disappear' });
    storage.clear();
    storage.setItem('theme', 'light');
    storage.setItem('stale-key', 'must disappear');
    const clearCredentials = vi.fn().mockResolvedValue(undefined);

    await importAllTables(await snapshot.arrayBuffer(), activeDb, {
      storage,
      clearProviderCredentials: clearCredentials,
    });

    expect(await activeDb.table('notes').toArray()).toEqual([
      { id: 'note-1', text: 'snapshot row' },
    ]);
    expect(storage.getItem('theme')).toBe('dark');
    expect(storage.getItem('stale-key')).toBeNull();
    expect(databaseMocks.replaceDatabase).toHaveBeenCalledWith(authoritativeDatabase, {
      globalLockHeld: true,
    });
    expect(clearCredentials).toHaveBeenCalledOnce();
  });

  it('rejects duplicate primary keys and unknown tables before changing any data', async () => {
    const activeDb = createDatabase({ notes: 'id' });
    await activeDb.table('notes').put({ id: 'note-1', text: 'one' });
    const snapshot = await exportAllTables(activeDb);
    const duplicate = await mutateArchive(snapshot, (_zip, manifest) => {
      manifest.tables.notes.push({ ...manifest.tables.notes[0] });
      manifest.counts.notes = 2;
    });
    const clearCredentials = vi.fn();

    await expect(
      importAllTables(duplicate, activeDb, { clearProviderCredentials: clearCredentials }),
    ).rejects.toThrow('duplicate primary key');
    expect(databaseMocks.replaceDatabase).not.toHaveBeenCalled();
    expect(clearCredentials).not.toHaveBeenCalled();

    const unknownTable = await mutateArchive(snapshot, (_zip, manifest) => {
      manifest.tables.futureTable = [];
      manifest.counts.futureTable = 0;
    });
    await expect(importAllTables(unknownTable, activeDb)).rejects.toThrow('unknown table');
    expect(databaseMocks.replaceDatabase).not.toHaveBeenCalled();
  });

  it('validates every Blob entry and its exact uncompressed size', async () => {
    const activeDb = createDatabase({ imageFiles: 'id' });
    await activeDb.table('imageFiles').put({
      id: 'image-1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    const snapshot = await exportAllTables(activeDb);
    const wrongSize = await mutateArchive(snapshot, (_zip, manifest) => {
      manifest.tables.imageFiles[0].blob!.size = 4;
    });

    await expect(importAllTables(wrongSize, activeDb)).rejects.toThrow('Blob size mismatch');
    expect(databaseMocks.replaceDatabase).not.toHaveBeenCalled();

    const missingEntry = await mutateArchive(snapshot, (zip, manifest) => {
      zip.remove(manifest.tables.imageFiles[0].blob!.__blob);
    });
    await expect(importAllTables(missingEntry, activeDb)).rejects.toThrow('Blob entry is missing');
    expect(databaseMocks.replaceDatabase).not.toHaveBeenCalled();
  });

  it('rolls the workspace back when credential clearing fails', async () => {
    const activeDb = createDatabase({ notes: 'id' });
    const storage = new MemoryStorage();
    storage.setItem('theme', 'snapshot-theme');
    await activeDb.table('notes').put({ id: 'snapshot-note' });
    const snapshot = await exportAllTables(activeDb, { storage });

    await activeDb.table('notes').clear();
    await activeDb.table('notes').put({ id: 'current-note' });
    storage.setItem('theme', 'current-theme');
    const clearCredentials = vi.fn().mockRejectedValue(new Error('vault unavailable'));
    const enterRecoveryMode = vi.fn();

    await expect(
      importAllTables(await snapshot.arrayBuffer(), activeDb, {
        storage,
        clearProviderCredentials: clearCredentials,
        enterRecoveryMode,
      }),
    ).rejects.toThrow('vault unavailable');

    expect(await activeDb.table('notes').toArray()).toEqual([{ id: 'current-note' }]);
    expect(storage.getItem('theme')).toBe('current-theme');
    expect(databaseMocks.replaceDatabase).toHaveBeenCalledTimes(2);
    expect(enterRecoveryMode).not.toHaveBeenCalled();
  });

  it('enters Recovery Mode when restoring the safety snapshot also fails', async () => {
    const activeDb = createDatabase({ notes: 'id' });
    await activeDb.table('notes').put({ id: 'snapshot-note' });
    const snapshot = await exportAllTables(activeDb);
    databaseMocks.replaceDatabase
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback storage unavailable'));
    const enterRecoveryMode = vi.fn().mockResolvedValue(undefined);

    const restore = importAllTables(await snapshot.arrayBuffer(), activeDb, {
      clearProviderCredentials: vi.fn().mockRejectedValue(new Error('vault unavailable')),
      enterRecoveryMode,
    });
    await expect(restore).rejects.toBeInstanceOf(RecoveryModeRequiredError);
    expect(enterRecoveryMode).toHaveBeenCalledWith(
      'Restore and automatic rollback both failed; Recovery Mode is required',
    );
  });
});
