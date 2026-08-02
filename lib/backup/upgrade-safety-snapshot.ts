import Dexie, { type EntityTable } from 'dexie';

import {
  exportAllTables,
  validateBackupSnapshot,
  type WorkspaceCompatibilityMetadata,
} from '@/lib/backup/db-backup';

const RECOVERY_DATABASE_NAME = 'OpenMAIC-Recovery';
const LATEST_SNAPSHOT_ID = 'latest-upgrade-safety';

interface StoredUpgradeSafetySnapshot {
  id: typeof LATEST_SNAPSHOT_ID;
  createdAt: string;
  workspace: WorkspaceCompatibilityMetadata;
  snapshot: Blob;
}

export interface UpgradeSafetySnapshot {
  createdAt: string;
  workspace: WorkspaceCompatibilityMetadata;
  snapshot: Blob;
}

export interface UpgradeSafetySnapshotStoreOptions {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof globalThis.IDBKeyRange;
  databaseName?: string;
}

class RecoveryDatabase extends Dexie {
  snapshots!: EntityTable<StoredUpgradeSafetySnapshot, 'id'>;

  constructor(options: UpgradeSafetySnapshotStoreOptions) {
    const dependencies = options.indexedDB
      ? {
          indexedDB: options.indexedDB,
          IDBKeyRange: options.IDBKeyRange ?? globalThis.IDBKeyRange,
        }
      : undefined;
    super(options.databaseName ?? RECOVERY_DATABASE_NAME, dependencies);
    this.version(1).stores({ snapshots: 'id, createdAt' });
  }
}

/**
 * Validate a replacement before atomically overwriting the previous safety
 * snapshot. A failed validation or IndexedDB transaction leaves the old entry
 * untouched.
 */
export async function storeLatestUpgradeSafetySnapshot(
  snapshot: Blob | ArrayBuffer,
  activeDb: Dexie,
  options: UpgradeSafetySnapshotStoreOptions = {},
): Promise<UpgradeSafetySnapshot> {
  const workspace = await validateBackupSnapshot(snapshot, activeDb);
  const portableSnapshot = snapshot instanceof Blob ? snapshot : new Blob([snapshot]);
  const record: StoredUpgradeSafetySnapshot = {
    id: LATEST_SNAPSHOT_ID,
    createdAt: new Date().toISOString(),
    workspace,
    snapshot: portableSnapshot,
  };
  const recoveryDb = new RecoveryDatabase(options);
  try {
    await recoveryDb.snapshots.put(record);
  } finally {
    recoveryDb.close();
  }
  return record;
}

export async function createLatestUpgradeSafetySnapshot(
  activeDb: Dexie,
  options: UpgradeSafetySnapshotStoreOptions = {},
): Promise<UpgradeSafetySnapshot> {
  const snapshot = await exportAllTables(activeDb);
  return storeLatestUpgradeSafetySnapshot(snapshot, activeDb, options);
}

export async function getLatestUpgradeSafetySnapshot(
  options: UpgradeSafetySnapshotStoreOptions = {},
): Promise<UpgradeSafetySnapshot | null> {
  const recoveryDb = new RecoveryDatabase(options);
  try {
    const record = await recoveryDb.snapshots.get(LATEST_SNAPSHOT_ID);
    if (!record) return null;
    return {
      createdAt: record.createdAt,
      workspace: record.workspace,
      snapshot: record.snapshot,
    };
  } finally {
    recoveryDb.close();
  }
}
