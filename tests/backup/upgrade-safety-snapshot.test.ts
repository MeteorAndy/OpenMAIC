import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  exportDatabase: vi.fn(),
  replaceDatabase: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => databaseMocks);

import { exportAllTables } from '@/lib/backup/db-backup';
import {
  getLatestUpgradeSafetySnapshot,
  storeLatestUpgradeSafetySnapshot,
} from '@/lib/backup/upgrade-safety-snapshot';

const authoritativeDatabase = { documents: [], chatSessions: [], playbackState: [] };
let activeDb: Dexie | undefined;

async function snapshotRows(snapshot: Blob): Promise<unknown[]> {
  const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
  const manifest = JSON.parse(await zip.file('backup.json')!.async('string'));
  return manifest.tables.notes;
}

beforeEach(() => {
  databaseMocks.exportDatabase.mockResolvedValue(authoritativeDatabase);
});

afterEach(() => {
  activeDb?.close();
  activeDb = undefined;
  vi.clearAllMocks();
});

describe('upgrade safety snapshot storage', () => {
  it('retains only the latest fully validated snapshot', async () => {
    const indexedDB = new IDBFactory();
    activeDb = new Dexie('upgrade-safety-active', { indexedDB, IDBKeyRange });
    activeDb.version(1).stores({ notes: 'id' });
    const storeOptions = {
      indexedDB,
      IDBKeyRange,
      databaseName: 'upgrade-safety-store',
    };

    await activeDb.table('notes').put({ id: 'first' });
    const first = await exportAllTables(activeDb);
    await storeLatestUpgradeSafetySnapshot(first, activeDb, storeOptions);

    await activeDb.table('notes').clear();
    await activeDb.table('notes').put({ id: 'second' });
    const second = await exportAllTables(activeDb);
    await storeLatestUpgradeSafetySnapshot(second, activeDb, storeOptions);

    const latest = await getLatestUpgradeSafetySnapshot(storeOptions);
    expect(latest).not.toBeNull();
    expect(await snapshotRows(latest!.snapshot)).toEqual([{ id: 'second' }]);
  });

  it('does not replace the previous snapshot when validation fails', async () => {
    const indexedDB = new IDBFactory();
    activeDb = new Dexie('upgrade-safety-validation-active', { indexedDB, IDBKeyRange });
    activeDb.version(1).stores({ notes: 'id' });
    const storeOptions = {
      indexedDB,
      IDBKeyRange,
      databaseName: 'upgrade-safety-validation-store',
    };

    await activeDb.table('notes').put({ id: 'safe' });
    const valid = await exportAllTables(activeDb);
    await storeLatestUpgradeSafetySnapshot(valid, activeDb, storeOptions);

    const zip = await JSZip.loadAsync(await valid.arrayBuffer());
    const manifest = JSON.parse(await zip.file('backup.json')!.async('string'));
    manifest.magic = 'not-openmaic';
    zip.file('backup.json', JSON.stringify(manifest));
    const invalid = await zip.generateAsync({ type: 'arraybuffer' });

    await expect(storeLatestUpgradeSafetySnapshot(invalid, activeDb, storeOptions)).rejects.toThrow(
      'bad magic',
    );
    const latest = await getLatestUpgradeSafetySnapshot(storeOptions);
    expect(await snapshotRows(latest!.snapshot)).toEqual([{ id: 'safe' }]);
  });
});
