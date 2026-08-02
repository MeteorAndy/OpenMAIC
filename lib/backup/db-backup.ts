/**
 * Portable, complete workspace snapshots for the MAIC browser databases.
 *
 * The archive is deliberately unencrypted. Provider credentials are omitted,
 * Blob values are stored as ZIP entries, and restore is an all-or-nothing
 * replacement guarded by an in-memory rollback snapshot.
 */
import type Dexie from 'dexie';
import type JSZip from 'jszip';
import type { exportDatabase as exportDatabaseType } from '@/lib/utils/database';

import { getTauriInvoke } from '@/lib/desktop/runtime';
import { withRuntimeStorageExclusiveLock } from '@/lib/utils/chat-storage-lock';

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_MAGIC = 'maic-db-backup';
export const BACKUP_EXTENSION = '.maic-backup';
export const WORKSPACE_COMPATIBILITY_VERSION = 1;
export const WORKSPACE_COMPATIBILITY_KEY = 'openmaic:workspace-compatibility';

const MAX_TOTAL_BLOB_BYTES = 2 * 1024 * 1024 * 1024;
const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'accesskeyid',
  'accesskeysecret',
  'secretaccesskey',
  'clientsecret',
  'password',
  'token',
  'authtoken',
  'bearertoken',
]);

/** Tables whose records carry one or more Blob columns. */
export const BLOB_FIELDS: Record<string, readonly string[]> = {
  audioFiles: ['blob'],
  imageFiles: ['blob'],
  mediaFiles: ['blob', 'poster'],
  voiceProfiles: ['referenceAudio'],
  autoVoiceCache: ['referenceAudio'],
};

interface BlobRef {
  __blob: string;
  mime: string;
  size: number;
}

export interface WorkspaceCompatibilityMetadata {
  version: typeof WORKSPACE_COMPATIBILITY_VERSION;
  schemaVersion: number;
  minimumReaderSchemaVersion: number;
  desktopVersion: string;
  recordedAt: string;
}

interface BackupJson {
  magic: string;
  format: number;
  dexieVersion: number;
  appVersion: string;
  exportedAt: string;
  workspace: WorkspaceCompatibilityMetadata;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  localStorage: Record<string, string>;
  database: Awaited<ReturnType<typeof exportDatabaseType>>;
}

interface PreparedBackup {
  metadata: BackupJson;
  tables: Record<string, Rec[]>;
  localStorage: Record<string, string>;
  database: BackupJson['database'];
}

export interface ImportBackupOptions {
  storage?: Storage;
  clearProviderCredentials?: () => Promise<void>;
  enterRecoveryMode?: (reason: string) => Promise<void>;
}

interface ExportBackupOptions {
  storage?: Storage;
  globalLockHeld?: boolean;
}

type Rec = Record<string, unknown>;

export class RecoveryModeRequiredError extends Error {
  constructor(
    public readonly restoreError: unknown,
    public readonly rollbackError: unknown,
  ) {
    super('Restore and automatic rollback both failed; Recovery Mode is required');
    this.name = 'RecoveryModeRequiredError';
  }
}

/** A timestamped filename for a backup blob. Caller performs the download. */
export function backupFilename(prefix = 'maic'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${ts}${BACKUP_EXTENSION}`;
}

function currentAppVersion(): string {
  return process.env.npm_package_version || 'unknown';
}

function ambientStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function normalizedFieldName(name: string): string {
  return name.replace(/[-_\s]/g, '').toLowerCase();
}

function isCredentialField(name: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(normalizedFieldName(name));
}

/** Recursively omit credential-shaped fields while retaining all other data. */
export function sanitizeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSnapshotValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isCredentialField(key))
      .map(([key, entry]) => [key, sanitizeSnapshotValue(entry)]),
  );
}

function captureNonSensitiveLocalStorage(storage: Storage | undefined): Record<string, string> {
  if (!storage) return {};
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || isCredentialField(key)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      snapshot[key] = JSON.stringify(sanitizeSnapshotValue(JSON.parse(raw)));
    } catch {
      snapshot[key] = raw;
    }
  }
  return snapshot;
}

function replaceLocalStorage(storage: Storage | undefined, snapshot: Record<string, string>): void {
  if (!storage) return;
  storage.clear();
  for (const [key, value] of Object.entries(snapshot)) storage.setItem(key, value);
}

function workspaceMetadata(db: Dexie): WorkspaceCompatibilityMetadata {
  return {
    version: WORKSPACE_COMPATIBILITY_VERSION,
    schemaVersion: db.verno,
    minimumReaderSchemaVersion: db.verno,
    desktopVersion: currentAppVersion(),
    recordedAt: new Date().toISOString(),
  };
}

/** Record the compatibility floor that future desktop versions must respect. */
export function recordWorkspaceCompatibility(
  db: Dexie,
  storage: Storage | undefined = ambientStorage(),
): WorkspaceCompatibilityMetadata {
  const metadata = workspaceMetadata(db);
  storage?.setItem(WORKSPACE_COMPATIBILITY_KEY, JSON.stringify(metadata));
  return metadata;
}

function isRecord(value: unknown): value is Rec {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    isRecord(value) &&
    typeof value.__blob === 'string' &&
    typeof value.mime === 'string' &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0
  );
}

function primaryKeyValue(rec: Rec, keyPath: string | string[] | undefined): unknown {
  if (Array.isArray(keyPath)) return keyPath.map((key) => rec[key]);
  if (typeof keyPath === 'string') return rec[keyPath];
  return rec.id;
}

function primaryKeyFingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Snapshot row is missing its primary key');
  return encoded;
}

function blobPath(table: string, primaryKey: unknown, field: string): string {
  return `blobs/${table}/${encodeURIComponent(primaryKeyFingerprint(primaryKey))}/${field}`;
}

function assertWorkspaceMetadata(value: unknown, db: Dexie): WorkspaceCompatibilityMetadata {
  if (!isRecord(value)) throw new Error('Invalid workspace compatibility metadata');
  if (value.version !== WORKSPACE_COMPATIBILITY_VERSION)
    throw new Error(`Unsupported workspace compatibility metadata v${String(value.version)}`);
  if (
    !Number.isSafeInteger(value.schemaVersion) ||
    !Number.isSafeInteger(value.minimumReaderSchemaVersion) ||
    (value.schemaVersion as number) < 0 ||
    (value.minimumReaderSchemaVersion as number) < 0
  )
    throw new Error('Invalid workspace schema version metadata');
  if ((value.minimumReaderSchemaVersion as number) > db.verno)
    throw new Error(
      `Snapshot requires workspace schema v${value.minimumReaderSchemaVersion}, current schema is v${db.verno}`,
    );
  if (typeof value.desktopVersion !== 'string' || typeof value.recordedAt !== 'string')
    throw new Error('Invalid workspace version metadata');
  return value as unknown as WorkspaceCompatibilityMetadata;
}

function assertDatabaseSnapshot(value: unknown): asserts value is BackupJson['database'] {
  if (!isRecord(value)) throw new Error('Snapshot database payload is missing');
  for (const field of ['documents', 'chatSessions', 'playbackState']) {
    if (!Array.isArray(value[field]))
      throw new Error(`Snapshot database.${field} must be an array`);
  }
}

async function exportAllTablesLocked(db: Dexie, storage: Storage | undefined): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const counts: Record<string, number> = {};
  const tablesJson: Record<string, unknown[]> = {};
  const { exportDatabase } = await import('@/lib/utils/database');
  const database = await exportDatabase({ globalLockHeld: true });
  const workspace = recordWorkspaceCompatibility(db, storage);

  for (const table of db.tables) {
    const rows = (await table.toArray()) as Rec[];
    counts[table.name] = rows.length;
    const blobFields = BLOB_FIELDS[table.name];
    if (!blobFields) {
      tablesJson[table.name] = rows;
      continue;
    }
    const keyPath = table.schema.primKey.keyPath as string | string[] | undefined;
    const serializedRows: Rec[] = [];
    for (const rec of rows) {
      const out: Rec = { ...rec };
      const primaryKey = primaryKeyValue(rec, keyPath);
      primaryKeyFingerprint(primaryKey);
      for (const field of blobFields) {
        const value = rec[field];
        if (!(value instanceof Blob)) continue;
        const path = blobPath(table.name, primaryKey, field);
        zip.file(path, await value.arrayBuffer());
        out[field] = { __blob: path, mime: value.type, size: value.size } satisfies BlobRef;
      }
      serializedRows.push(out);
    }
    tablesJson[table.name] = serializedRows;
  }

  const backup: BackupJson = {
    magic: BACKUP_MAGIC,
    format: BACKUP_FORMAT_VERSION,
    dexieVersion: db.verno,
    appVersion: currentAppVersion(),
    exportedAt: new Date().toISOString(),
    workspace,
    counts,
    tables: tablesJson,
    localStorage: captureNonSensitiveLocalStorage(storage),
    database,
  };
  zip.file('backup.json', JSON.stringify(backup));
  return zip.generateAsync({ type: 'blob' });
}

/** Dump the complete, non-sensitive active workspace to a ZIP Blob. */
export function exportAllTables(db: Dexie, options: ExportBackupOptions = {}): Promise<Blob> {
  const storage = options.storage ?? ambientStorage();
  return options.globalLockHeld
    ? exportAllTablesLocked(db, storage)
    : withRuntimeStorageExclusiveLock(() => exportAllTablesLocked(db, storage));
}

async function rehydrateAndValidateRecord(
  zip: JSZip,
  tableName: string,
  primaryKey: unknown,
  rec: Rec,
  fields: readonly string[],
  referencedEntries: Set<string>,
  totalBytes: { value: number },
): Promise<Rec> {
  const out: Rec = { ...rec };
  for (const field of fields) {
    const value = rec[field];
    if (value === undefined || value === null) continue;
    if (!isBlobRef(value)) throw new Error(`Invalid Blob reference at ${tableName}.${field}`);
    const expectedPath = blobPath(tableName, primaryKey, field);
    if (value.__blob !== expectedPath)
      throw new Error(`Unexpected Blob path at ${tableName}.${field}: ${value.__blob}`);
    if (referencedEntries.has(value.__blob))
      throw new Error(`Blob entry is referenced more than once: ${value.__blob}`);
    const entry = zip.file(value.__blob);
    if (!entry || entry.dir) throw new Error(`Blob entry is missing: ${value.__blob}`);
    totalBytes.value += value.size;
    if (totalBytes.value > MAX_TOTAL_BLOB_BYTES)
      throw new Error('Snapshot Blob payload exceeds the 2 GiB safety limit');
    const bytes = await entry.async('uint8array');
    if (bytes.byteLength !== value.size)
      throw new Error(
        `Blob size mismatch for ${value.__blob}: expected ${value.size}, got ${bytes.byteLength}`,
      );
    referencedEntries.add(value.__blob);
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    out[field] = new Blob([blobBytes.buffer], { type: value.mime });
  }
  return out;
}

/** Parse and fully validate a snapshot without mutating the active workspace. */
async function prepareBackup(zipBlob: Blob | ArrayBuffer, db: Dexie): Promise<PreparedBackup> {
  const JSZip = (await import('jszip')).default;
  const source = zipBlob instanceof Blob ? await zipBlob.arrayBuffer() : zipBlob;
  const zip = await JSZip.loadAsync(source);
  const manifest = zip.file('backup.json');
  if (!manifest) throw new Error('Not a MAIC backup: backup.json missing');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await manifest.async('string'));
  } catch {
    throw new Error('Not a MAIC backup: backup.json is invalid');
  }
  if (!isRecord(parsed)) throw new Error('Not a MAIC backup: invalid manifest');
  if (parsed.magic !== BACKUP_MAGIC)
    throw new Error(`Not a MAIC backup (bad magic): ${String(parsed.magic)}`);
  if (parsed.format !== BACKUP_FORMAT_VERSION)
    throw new Error(
      `Unsupported backup format v${String(parsed.format)}, expected v${BACKUP_FORMAT_VERSION}`,
    );
  if (typeof parsed.dexieVersion !== 'number' || parsed.dexieVersion > db.verno)
    throw new Error(
      `Snapshot database schema v${String(parsed.dexieVersion)} is newer than current v${db.verno}`,
    );
  const workspace = assertWorkspaceMetadata(parsed.workspace, db);
  if (workspace.schemaVersion !== parsed.dexieVersion)
    throw new Error('Snapshot workspace schema metadata does not match its database version');
  assertDatabaseSnapshot(parsed.database);
  if (!isRecord(parsed.counts) || !isRecord(parsed.tables))
    throw new Error('Snapshot table manifest is invalid');
  if (!isRecord(parsed.localStorage)) throw new Error('Snapshot localStorage payload is invalid');

  const localStorageSnapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.localStorage)) {
    if (typeof value !== 'string' || isCredentialField(key))
      throw new Error(`Invalid or sensitive localStorage entry: ${key}`);
    try {
      const decoded = JSON.parse(value);
      if (JSON.stringify(sanitizeSnapshotValue(decoded)) !== JSON.stringify(decoded))
        throw new Error(`Snapshot contains a sensitive localStorage field: ${key}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Snapshot contains a sensitive'))
        throw error;
      // Non-JSON localStorage values are valid and remain byte-for-byte portable.
    }
    localStorageSnapshot[key] = value;
  }

  const liveNames = new Set(db.tables.map((table) => table.name));
  const manifestNames = Object.keys(parsed.tables);
  for (const name of manifestNames) {
    if (!liveNames.has(name)) throw new Error(`Snapshot contains unknown table: ${name}`);
  }
  for (const name of liveNames) {
    if (!(name in parsed.tables))
      throw new Error(`Snapshot is incomplete: table ${name} is missing`);
    if (!(name in parsed.counts)) throw new Error(`Snapshot count is missing for table ${name}`);
  }
  for (const name of Object.keys(parsed.counts)) {
    if (!liveNames.has(name)) throw new Error(`Snapshot contains an unknown table count: ${name}`);
  }

  const restored: Record<string, Rec[]> = {};
  const referencedEntries = new Set<string>();
  const totalBytes = { value: 0 };
  for (const table of db.tables) {
    const rows = parsed.tables[table.name];
    if (!Array.isArray(rows)) throw new Error(`Snapshot table ${table.name} must be an array`);
    const expectedCount = parsed.counts[table.name];
    if (
      typeof expectedCount !== 'number' ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      expectedCount !== rows.length
    )
      throw new Error(`Snapshot count mismatch for table ${table.name}`);
    const keyPath = table.schema.primKey.keyPath as string | string[] | undefined;
    const seenKeys = new Set<string>();
    const records: Rec[] = [];
    for (const row of rows) {
      if (!isRecord(row)) throw new Error(`Snapshot table ${table.name} contains a non-object row`);
      const primaryKey = primaryKeyValue(row, keyPath);
      const fingerprint = primaryKeyFingerprint(primaryKey);
      if (seenKeys.has(fingerprint))
        throw new Error(
          `Snapshot table ${table.name} contains duplicate primary key ${fingerprint}`,
        );
      seenKeys.add(fingerprint);
      const blobFields = BLOB_FIELDS[table.name];
      records.push(
        blobFields
          ? await rehydrateAndValidateRecord(
              zip,
              table.name,
              primaryKey,
              row,
              blobFields,
              referencedEntries,
              totalBytes,
            )
          : row,
      );
    }
    restored[table.name] = records;
  }

  const archiveBlobEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir && entry.name.startsWith('blobs/'))
    .map((entry) => entry.name);
  for (const entry of archiveBlobEntries) {
    if (!referencedEntries.has(entry))
      throw new Error(`Snapshot contains unreferenced Blob: ${entry}`);
  }

  return {
    metadata: parsed as unknown as BackupJson,
    tables: restored,
    localStorage: localStorageSnapshot,
    database: parsed.database,
  };
}

async function defaultClearProviderCredentials(): Promise<void> {
  const invoke = getTauriInvoke();
  if (invoke) await invoke('clear_provider_credentials');
}

async function defaultEnterRecoveryMode(reason: string): Promise<void> {
  const invoke = getTauriInvoke();
  if (invoke) await invoke('enter_recovery_mode', { reason });
}

async function applyPreparedBackup(
  backup: PreparedBackup,
  db: Dexie,
  storage: Storage | undefined,
): Promise<void> {
  const { replaceDatabase } = await import('@/lib/utils/database');
  await replaceDatabase(backup.database, { globalLockHeld: true });
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
    for (const table of db.tables) {
      const rows = backup.tables[table.name];
      if (rows.length > 0) await table.bulkAdd(rows);
    }
  });
  replaceLocalStorage(storage, backup.localStorage);
}

/**
 * Replace the complete active workspace with a validated snapshot.
 *
 * The current workspace is first captured in memory under the maintenance
 * lock. Any failure restores that pre-image. A failed rollback transitions the
 * native shell to Recovery Mode and throws {@link RecoveryModeRequiredError}.
 */
export async function importAllTables(
  zipBlob: Blob | ArrayBuffer,
  db: Dexie,
  options: ImportBackupOptions = {},
): Promise<void> {
  const requested = await prepareBackup(zipBlob, db);
  const storage = options.storage ?? ambientStorage();
  const clearCredentials = options.clearProviderCredentials ?? defaultClearProviderCredentials;
  const enterRecoveryMode = options.enterRecoveryMode ?? defaultEnterRecoveryMode;

  await withRuntimeStorageExclusiveLock(async () => {
    const rollbackBlob = await exportAllTables(db, { storage, globalLockHeld: true });
    const rollback = await prepareBackup(rollbackBlob, db);
    try {
      await applyPreparedBackup(requested, db, storage);
      // This is deliberately the last fallible step. The native command rolls
      // back any partial Credential Manager deletion before returning an error.
      await clearCredentials();
    } catch (restoreError) {
      try {
        await applyPreparedBackup(rollback, db, storage);
      } catch (rollbackError) {
        const recoveryError = new RecoveryModeRequiredError(restoreError, rollbackError);
        try {
          await enterRecoveryMode(recoveryError.message);
        } catch {
          // The typed error remains actionable even when the native shell is absent.
        }
        throw recoveryError;
      }
      throw restoreError;
    }
  });
}

/** Validate an archive and return its compatibility metadata without applying it. */
export async function validateBackupSnapshot(
  zipBlob: Blob | ArrayBuffer,
  db: Dexie,
): Promise<WorkspaceCompatibilityMetadata> {
  return (await prepareBackup(zipBlob, db)).metadata.workspace;
}

/** Export and validate the active workspace without mutating it. */
export async function selfCheckBackup(db: Dexie): Promise<boolean> {
  const snapshot = await exportAllTables(db);
  await validateBackupSnapshot(snapshot, db);
  return true;
}
