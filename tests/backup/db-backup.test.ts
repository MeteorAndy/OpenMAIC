import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  exportDatabase: vi.fn(),
  importDatabase: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => databaseMocks);

import { exportAllTables, importAllTables } from '@/lib/backup/db-backup';

let db: Dexie | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  vi.clearAllMocks();
});

describe('database backup', () => {
  it('includes and restores the authoritative document/runtime snapshot', async () => {
    const database = {
      documents: [{ stage: { id: 'stage-1', name: 'Saved course' }, scenes: [] }],
      chatSessions: [],
      playbackState: [],
    };
    databaseMocks.exportDatabase.mockResolvedValue(database);
    db = new Dexie('maic-backup-test', { indexedDB: new IDBFactory(), IDBKeyRange });
    db.version(1).stores({ notes: 'id' });
    await db.table('notes').put({ id: 'note-1', text: 'legacy table row' });

    const blob = await exportAllTables(db);
    const zipBytes = await blob.arrayBuffer();
    const zip = await JSZip.loadAsync(zipBytes);
    const backup = JSON.parse(await zip.file('backup.json')!.async('string'));
    expect(backup.database).toEqual(database);

    // JSZip's Node build accepts ArrayBuffer but not Node's Blob implementation.
    await importAllTables(zipBytes as unknown as Blob, db);
    expect(databaseMocks.importDatabase).toHaveBeenCalledWith(database);
  });
});
