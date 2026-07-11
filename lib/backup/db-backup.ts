/**
 * Full-database backup/restore for the MAIC IndexedDB store.
 *
 * Defense-in-depth against residual local-data loss vectors (macOS ITP 7-day
 * eviction, disk pressure, WebKit random-clear bug, accidental user deletion).
 * Produces a faithful `.maic-backup` snapshot: original primary keys are
 * preserved (unlike the classroom-share path which regenerates IDs), and Blob
 * fields are shuttled through the ZIP as binary entries — never base64-inlined.
 *
 * Pure logic only — no React, no file-saver. A later task wires the download
 * hook + settings UI on top of these primitives.
 */
import type Dexie from 'dexie';
import type JSZip from 'jszip';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAGIC = 'maic-db-backup';
export const BACKUP_EXTENSION = '.maic-backup';

/**
 * Tables whose records carry one or more Blob columns. Each Blob is extracted
 * into its own zip entry on export and rehydrated on import. Verified against
 * the interfaces in lib/utils/database.ts (v11).
 */
export const BLOB_FIELDS: Record<string, readonly string[]> = {
  audioFiles: ['blob'],
  imageFiles: ['blob'],
  mediaFiles: ['blob', 'poster'],
  voiceProfiles: ['referenceAudio'],
  autoVoiceCache: ['referenceAudio'],
};

/** Marker stored in place of a Blob field; points at the zip entry holding it. */
interface BlobRef {
  __blob: string;
  mime: string;
  size: number;
}

interface BackupJson {
  magic: string;
  format: number;
  dexieVersion: number;
  appVersion: string;
  exportedAt: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

type Rec = Record<string, unknown>;

/** A timestamped filename for a backup blob. Caller does the actual saveAs. */
export function backupFilename(prefix = 'maic'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${ts}${BACKUP_EXTENSION}`;
}

function isBlobRef(v: unknown): v is BlobRef {
  return !!v && typeof v === 'object' && '__blob' in (v as Record<string, unknown>);
}

function pkOf(rec: Rec, keyPath: string | string[] | undefined): string {
  // ponytail: out-of-line keys (keyPath undefined) don't occur in any MAIC table,
  // so falling back to 'id' is safe and keeps the blob path stable-typed.
  if (keyPath === undefined) return String(rec.id ?? 'noid');
  if (Array.isArray(keyPath)) return keyPath.map((k) => String(rec[k])).join('/');
  return String(rec[keyPath]);
}

/** Dump every table to a ZIP Blob. Blob fields become entries under blobs/. */
export async function exportAllTables(db: Dexie): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const counts: Record<string, number> = {};
  const tablesJson: Record<string, unknown[]> = {};

  for (const table of db.tables) {
    const name = table.name;
    const rows = (await table.toArray()) as Rec[];
    counts[name] = rows.length;
    const blobCols = BLOB_FIELDS[name];
    if (!blobCols) {
      tablesJson[name] = rows;
      continue;
    }
    const kp = table.schema.primKey.keyPath;
    tablesJson[name] = rows.map((rec) => {
      const out: Rec = { ...rec };
      for (const field of blobCols) {
        const v = rec[field];
        if (v instanceof Blob) {
          const path = `blobs/${name}/${pkOf(rec, kp)}/${field}`;
          zip.file(path, v);
          out[field] = { __blob: path, mime: v.type, size: v.size } satisfies BlobRef;
        }
      }
      return out;
    });
  }

  const backup: BackupJson = {
    magic: BACKUP_MAGIC,
    format: BACKUP_FORMAT_VERSION,
    dexieVersion: db.verno,
    appVersion: process.env.npm_package_version || 'unknown',
    exportedAt: new Date().toISOString(),
    counts,
    tables: tablesJson,
  };
  zip.file('backup.json', JSON.stringify(backup));
  return zip.generateAsync({ type: 'blob' });
}

/** Rehydrate Blob fields on a single record by reading refs back from the zip. */
async function rehydrateRecord(zip: JSZip, rec: Rec, fields: readonly string[]): Promise<Rec> {
  const out: Rec = { ...rec };
  for (const field of fields) {
    const v = rec[field];
    if (isBlobRef(v)) {
      const entry = zip.file(v.__blob);
      out[field] = entry ? await entry.async('blob') : new Blob();
    }
  }
  return out;
}

/**
 * Restore a `.maic-backup` ZIP into the live DB. Upserts by primary key:
 * same ID overwrites, new ID inserts, records absent from the backup are
 * preserved. Never clears tables first — restore is strictly additive.
 *
 * @throws if the blob is not a valid MAIC backup, or if the backup was taken
 *   on a newer DB schema than the current one (`backup.dexieVersion > db.verno`).
 *   An older backup is restored best-effort (caller may warn the user).
 */
export async function importAllTables(zipBlob: Blob, db: Dexie): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(zipBlob);
  const bf = zip.file('backup.json');
  if (!bf) throw new Error('Not a MAIC backup: backup.json missing');
  const backup = JSON.parse(await bf.async('string')) as BackupJson;
  if (backup.magic !== BACKUP_MAGIC)
    throw new Error(`Not a MAIC backup (bad magic): ${String(backup.magic)}`);
  if (backup.format !== BACKUP_FORMAT_VERSION)
    throw new Error(
      `Unsupported backup format v${backup.format}, expected v${BACKUP_FORMAT_VERSION}`,
    );
  if (backup.dexieVersion > db.verno)
    throw new Error(
      `Backup is from a newer database (v${backup.dexieVersion}) than the current one (v${db.verno}) — refusing to restore`,
    );

  const liveNames = new Set(db.tables.map((t) => t.name));
  const restored: Record<string, Rec[]> = {};
  for (const [name, rows] of Object.entries(backup.tables)) {
    if (!liveNames.has(name)) continue; // ponytail: silently skip tables no longer in the schema
    const blobCols = BLOB_FIELDS[name];
    const recs = rows as Rec[];
    restored[name] = blobCols
      ? await Promise.all(recs.map((r) => rehydrateRecord(zip, r, blobCols)))
      : recs;
  }

  await db.transaction('rw', db.tables, async () => {
    for (const [name, recs] of Object.entries(restored)) {
      if (recs.length > 0) await db.table(name).bulkPut(recs);
    }
  });
}

/**
 * In-browser round-trip self-check (the repo has no fake-indexeddb, so a Node
 * vitest case can't exercise Dexie). Exports the live DB, parses the ZIP back,
 * and asserts: (1) per-table counts match the live DB, and (2) a known Blob
 * field rehydrates from its zip entry to a non-empty Blob of the recorded size.
 * Invoke from the dev console or a dev-only menu. Returns true on success,
 * throws on any mismatch.
 */
export async function selfCheckBackup(db: Dexie): Promise<boolean> {
  const zipBlob = await exportAllTables(db);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(zipBlob);
  const backup = JSON.parse(await zip.file('backup.json')!.async('string')) as BackupJson;

  if (backup.magic !== BACKUP_MAGIC) throw new Error('selfCheck: bad magic');
  for (const table of db.tables) {
    const live = await table.count();
    if (backup.counts[table.name] !== live)
      throw new Error(
        `selfCheck: count mismatch for ${table.name} (backup=${backup.counts[table.name]} live=${live})`,
      );
  }

  // Prove a Blob column actually round-trips: pick the first non-empty blob table.
  const blobTable = Object.keys(BLOB_FIELDS).find((n) => (backup.tables[n]?.length ?? 0) > 0);
  if (blobTable) {
    const field = BLOB_FIELDS[blobTable][0];
    const rec = backup.tables[blobTable][0] as Rec;
    if (!(rec[field] instanceof Blob) && !isBlobRef(rec[field]))
      throw new Error(`selfCheck: ${blobTable}.${field} neither Blob nor ref after export`);
    const rehydrated = await rehydrateRecord(zip, rec, BLOB_FIELDS[blobTable]);
    const blob = rehydrated[field];
    if (!(blob instanceof Blob) || blob.size === 0)
      throw new Error(`selfCheck: ${blobTable}.${field} did not round-trip to a non-empty Blob`);
    const ref = rec[field] as BlobRef;
    if (isBlobRef(ref) && blob.size !== ref.size)
      throw new Error(
        `selfCheck: ${blobTable}.${field} size mismatch (zip=${blob.size} ref=${ref.size})`,
      );
  }
  return true;
}
