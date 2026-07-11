'use client';

import { useState, useCallback, useRef } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db } from '@/lib/utils/database';
import {
  exportAllTables,
  importAllTables,
  backupFilename,
  BACKUP_EXTENSION,
} from '@/lib/backup/db-backup';
import { createLogger } from '@/lib/logger';

const log = createLogger('Backup');

export type RestorePhase = 'idle' | 'reading' | 'restoring' | 'done' | 'error';

const MAX_SAFE_SIZE = 200 * 1024 * 1024;

/**
 * React layer over db-backup primitives. Mirrors use-import-classroom's shape:
 * phase enum, file input ref, size warn, QuotaExceededError handling. Restore
 * ends with window.location.reload() — bulkPut leaves zustand/React holding
 * stale refs, same reason clearCache reloads.
 */
export function useBackup() {
  const { t } = useI18n();
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const triggerBackup = useCallback(async () => {
    setIsBackingUp(true);
    const toastId = toast.loading(t('settings.backupButton'));
    try {
      const blob = await exportAllTables(db);
      saveAs(blob, backupFilename());
      toast.success(t('settings.backupSuccess'), { id: toastId });
    } catch (err) {
      log.error('Backup failed:', err);
      toast.error(t('settings.restoreFailed'), { id: toastId });
    } finally {
      setIsBackingUp(false);
    }
  }, [t]);

  const triggerRestore = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(BACKUP_EXTENSION)) {
        toast.error(t('settings.restoreFailed'));
        return;
      }
      if (file.size > MAX_SAFE_SIZE) {
        log.warn(`Large backup file: ${(file.size / 1024 / 1024).toFixed(0)}MB`);
      }

      setIsRestoring(true);
      setRestorePhase('reading');
      setError(null);
      const toastId = toast.loading(t('settings.restoreButton'));
      try {
        setRestorePhase('restoring');
        // File extends Blob; importAllTables reads it as a ZIP directly.
        await importAllTables(file, db);
        setRestorePhase('done');
        toast.success(t('settings.restoreSuccess'), { id: toastId });
        setTimeout(() => window.location.reload(), 1000);
      } catch (err) {
        log.error('Restore failed:', err);
        const isQuotaError = err instanceof DOMException && err.name === 'QuotaExceededError';
        // Quota → generic localized message; otherwise surface the real reason
        // (bad magic, format mismatch, newer-DB refusal — all user-readable).
        const msg = isQuotaError
          ? t('settings.restoreFailed')
          : err instanceof Error
            ? err.message
            : String(err);
        setRestorePhase('error');
        setError(msg);
        toast.error(msg, { id: toastId });
        setIsRestoring(false);
      }
    },
    [t],
  );

  return {
    isBackingUp,
    isRestoring,
    restorePhase,
    error,
    fileInputRef,
    triggerBackup,
    triggerRestore,
    triggerFileSelect,
  };
}
