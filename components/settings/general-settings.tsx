'use client';

import { useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { UsageDashboard } from './usage-dashboard';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, AlertTriangle, Download, Upload } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { clearDatabase } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { useBackup } from '@/lib/backup/use-backup';
import { TrustedProviderEndpoints } from './trusted-provider-endpoints';

const log = createLogger('GeneralSettings');

/**
 * The shape of a zustand `persist` API this file needs. Declared structurally
 * so one helper covers both stores without importing either state type.
 */
interface PersistApi {
  getOptions: () => {
    name?: string;
    storage?: { removeItem: (name: string) => unknown };
  };
}

/**
 * Clear a store that persists through the KVStore.
 *
 * Not `persist.clearStorage()`: that discards the promise our KV-backed storage
 * returns, and clearing has to be awaited before the reload below.
 */
async function clearPersistedStore(persistApi: PersistApi, fallbackName: string): Promise<void> {
  const { storage, name } = persistApi.getOptions();
  await storage?.removeItem(name ?? fallbackName);
}

export function GeneralSettings() {
  const { t } = useI18n();
  const {
    isBackingUp,
    isRestoring,
    fileInputRef,
    triggerBackup,
    triggerRestore,
    triggerFileSelect,
  } = useBackup();

  // Clear cache state
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const confirmPhrase = t('settings.clearCacheConfirmPhrase');
  const isConfirmValid = confirmInput === confirmPhrase;

  // Restore state — file is picked first, then a typed-confirm dialog guards the overwrite.
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmInput, setRestoreConfirmInput] = useState('');

  const restorePhrase = t('settings.restoreConfirmPhrase');
  const isRestoreConfirmValid = restoreConfirmInput === restorePhrase;

  const handleRestoreFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setRestoreFile(file);
    setRestoreConfirmInput('');
    setShowRestoreDialog(true);
  }, []);

  const handleRestoreConfirm = useCallback(async () => {
    if (!isRestoreConfirmValid || !restoreFile) return;
    await triggerRestore(restoreFile);
    setShowRestoreDialog(false);
    setRestoreFile(null);
  }, [isRestoreConfirmValid, restoreFile, triggerRestore]);

  const handleClearCache = useCallback(async () => {
    if (!isConfirmValid) return;
    setClearing(true);
    try {
      // 1. Clear IndexedDB
      await clearDatabase();
      // 2. Clear localStorage
      localStorage.clear();
      // 3. Clear sessionStorage
      sessionStorage.clear();
      // 4. Clear the stores that persist through the KVStore. The blanket
      // clear above only reaches them because the KV browser backend happens
      // to sit on localStorage; under a server-backed `account` scope it would
      // report success and the data would come straight back on reload. The
      // remaining ad-hoc localStorage keys still rely on that blanket clear —
      // they lose the dependency as they move to the KVStore.
      await Promise.all([
        clearPersistedStore(useSettingsStore.persist, 'settings-storage'),
        clearPersistedStore(useUserProfileStore.persist, 'user-profile-storage'),
      ]);

      toast.success(t('settings.clearCacheSuccess'));

      // Reload without waiting. The stores are still live in memory, so the
      // longer this page stays up the more chances a `set()` has to persist
      // something after the clear. The seam refuses writes for the duration of
      // a clear, which covers writes issued while the deletes are in flight,
      // but not ones issued after they complete — hence keeping the window
      // short as well.
      window.location.reload();
    } catch (error) {
      log.error('Failed to clear cache:', error);
      toast.error(t('settings.clearCacheFailed'));
      setClearing(false);
    }
  }, [isConfirmValid, t]);

  const clearCacheItems =
    t('settings.clearCacheConfirmItems').split('、').length > 1
      ? t('settings.clearCacheConfirmItems').split('、')
      : t('settings.clearCacheConfirmItems').split(', ');

  return (
    <div className="flex flex-col gap-8">
      {/* Backup & Restore */}
      <div className="rounded-xl border bg-card">
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-muted text-muted-foreground">
              <Download className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold">{t('settings.backupTitle')}</h3>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed -mt-1">
            {t('settings.backupDescription')}
          </p>

          {/* Backup row */}
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium flex-1 min-w-0">{t('settings.backupButton')}</p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={isBackingUp || isRestoring}
              onClick={triggerBackup}
            >
              {isBackingUp ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('settings.backupButton')}
            </Button>
          </div>

          {/* Restore row */}
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <p className="text-sm font-medium flex-1 min-w-0">{t('settings.restoreButton')}</p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={isBackingUp || isRestoring}
              onClick={triggerFileSelect}
            >
              {isRestoring ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('settings.restoreButton')}
            </Button>
          </div>

          {/* Hidden file input for restore */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".maic-backup"
            className="hidden"
            onChange={handleRestoreFileChange}
          />
        </div>
      </div>

      {/* Usage statistics dashboard */}
      <UsageDashboard />

      <TrustedProviderEndpoints />

      {/* Danger Zone - Clear Cache */}
      <div className="relative rounded-xl border border-destructive/30 bg-destructive/[0.03] dark:bg-destructive/[0.06] overflow-hidden">
        {/* Subtle diagonal stripe pattern for danger emphasis */}
        <div
          className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              transparent,
              transparent 10px,
              currentColor 10px,
              currentColor 11px
            )`,
          }}
        />

        <div className="relative p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-destructive">{t('settings.dangerZone')}</h3>
          </div>

          {/* Content */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{t('settings.clearCache')}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t('settings.clearCacheDescription')}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setConfirmInput('');
                setShowClearDialog(true);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.clearCache')}
            </Button>
          </div>
        </div>
      </div>

      {/* Clear Cache Confirmation Dialog */}
      <AlertDialog
        open={showClearDialog}
        onOpenChange={(open) => {
          if (!clearing) {
            setShowClearDialog(open);
            if (!open) setConfirmInput('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('settings.clearCacheConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('settings.clearCacheConfirmDescription')}</p>
                <ul className="space-y-1.5 ml-1">
                  {clearCacheItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive/60 shrink-0" />
                      {item.trim()}
                    </li>
                  ))}
                </ul>
                <div className="pt-1">
                  <Label className="text-xs font-medium text-foreground">
                    {t('settings.clearCacheConfirmInput')}
                  </Label>
                  <Input
                    className="mt-1.5 h-9 text-sm"
                    placeholder={confirmPhrase}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isConfirmValid) {
                        handleClearCache();
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!isConfirmValid || clearing}
              onClick={handleClearCache}
            >
              {clearing ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1.5" />
              )}
              {t('settings.clearCacheButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore Confirmation Dialog */}
      <AlertDialog
        open={showRestoreDialog}
        onOpenChange={(open) => {
          if (!isRestoring) {
            setShowRestoreDialog(open);
            if (!open) {
              setRestoreConfirmInput('');
              setRestoreFile(null);
            }
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('settings.restoreConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('settings.restoreConfirmDescription')}</p>
                {restoreFile && (
                  <p className="text-xs text-muted-foreground break-all">{restoreFile.name}</p>
                )}
                <div className="pt-1">
                  <Label className="text-xs font-medium text-foreground">
                    {t('settings.restoreConfirmInput')}
                  </Label>
                  <Input
                    className="mt-1.5 h-9 text-sm"
                    placeholder={restorePhrase}
                    value={restoreConfirmInput}
                    onChange={(e) => setRestoreConfirmInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isRestoreConfirmValid) {
                        handleRestoreConfirm();
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!isRestoreConfirmValid || isRestoring}
              onClick={handleRestoreConfirm}
            >
              {isRestoring ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-1.5" />
              )}
              {t('settings.restoreButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
