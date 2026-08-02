'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Network, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getTauriInvoke } from '@/lib/desktop/runtime';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('TrustedProviderEndpoints');

export function TrustedProviderEndpoints() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    let ignore = false;
    setAvailable(true);
    void invoke<string[]>('get_trusted_provider_endpoints')
      .then((values) => {
        if (!ignore) setEndpoints(values);
      })
      .catch((error) => log.error('Could not load trusted provider endpoints:', error));
    return () => {
      ignore = true;
    };
  }, []);

  const proposeEndpoint = useCallback(() => {
    try {
      const url = new URL(input.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('invalid endpoint');
      }
      setPending(url.toString());
    } catch {
      toast.error(t('settings.trustedEndpointInvalid'));
    }
  }, [input, t]);

  const updateEndpoint = useCallback(async (endpoint: string, trusted: boolean) => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setSaving(true);
    try {
      const values = await invoke<string[]>('set_trusted_provider_endpoint', {
        endpoint,
        trusted,
      });
      setEndpoints(values);
      if (trusted) setInput('');
      setPending(null);
    } catch (error) {
      log.error('Could not update trusted provider endpoint:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, []);

  if (!available) return null;

  return (
    <>
      <div className="rounded-xl border bg-card">
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-muted text-muted-foreground">
              <Network className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold">{t('settings.trustedEndpointsTitle')}</h3>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed -mt-1">
            {t('settings.trustedEndpointsDescription')}
          </p>
          <div className="flex gap-2">
            <Input
              type="url"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && input.trim()) proposeEndpoint();
              }}
              placeholder={t('settings.trustedEndpointPlaceholder')}
              autoComplete="off"
              className="h-8"
            />
            <Button size="sm" variant="outline" disabled={!input.trim()} onClick={proposeEndpoint}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.trustedEndpointAdd')}
            </Button>
          </div>
          {endpoints.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('settings.trustedEndpointEmpty')}</p>
          ) : (
            <div className="divide-y border-t">
              {endpoints.map((endpoint) => (
                <div key={endpoint} className="flex items-center gap-3 py-2.5">
                  <code className="text-xs flex-1 min-w-0 break-all">{endpoint}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    title={t('common.delete')}
                    disabled={saving}
                    onClick={() => void updateEndpoint(endpoint, false)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              {t('settings.trustedEndpointConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">{t('settings.trustedEndpointConfirmDescription')}</span>
              <code className="block text-xs break-all text-foreground">{pending}</code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving || !pending}
              onClick={(event) => {
                event.preventDefault();
                if (pending) void updateEndpoint(pending, true);
              }}
            >
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              {t('settings.trustedEndpointAdd')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
