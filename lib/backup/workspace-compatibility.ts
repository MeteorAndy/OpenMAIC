import type Dexie from 'dexie';

import {
  WORKSPACE_COMPATIBILITY_KEY,
  WORKSPACE_COMPATIBILITY_VERSION,
  type WorkspaceCompatibilityMetadata,
} from '@/lib/backup/db-backup';

export type WorkspaceCompatibilityStatus =
  | { state: 'compatible'; metadata: WorkspaceCompatibilityMetadata | null }
  | { state: 'blocked'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Pure startup check. It never opens IndexedDB or changes workspace state. */
export function inspectWorkspaceCompatibility(
  db: Dexie,
  storage: Storage,
): WorkspaceCompatibilityStatus {
  let raw: string | null;
  try {
    raw = storage.getItem(WORKSPACE_COMPATIBILITY_KEY);
  } catch (error) {
    return { state: 'blocked', reason: `无法读取工作区兼容性信息：${String(error)}` };
  }
  if (raw === null) return { state: 'compatible', metadata: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'blocked', reason: '工作区兼容性信息已损坏。' };
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== WORKSPACE_COMPATIBILITY_VERSION ||
    !Number.isSafeInteger(parsed.schemaVersion) ||
    !Number.isSafeInteger(parsed.minimumReaderSchemaVersion) ||
    typeof parsed.desktopVersion !== 'string' ||
    typeof parsed.recordedAt !== 'string'
  ) {
    return { state: 'blocked', reason: '工作区兼容性信息无效或来自不支持的格式。' };
  }
  if ((parsed.minimumReaderSchemaVersion as number) > db.verno) {
    return {
      state: 'blocked',
      reason: `此工作区至少需要数据架构 v${parsed.minimumReaderSchemaVersion}，当前桌面版本仅支持 v${db.verno}。工作区数据尚未被修改。`,
    };
  }
  return {
    state: 'compatible',
    metadata: parsed as unknown as WorkspaceCompatibilityMetadata,
  };
}
