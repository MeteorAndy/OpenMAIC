'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { recordWorkspaceCompatibility } from '@/lib/backup/db-backup';
import { inspectWorkspaceCompatibility } from '@/lib/backup/workspace-compatibility';
import { getTauriInvoke } from '@/lib/desktop/runtime';
import { db } from '@/lib/utils/database';

type StartupState = 'checking' | 'compatible' | 'blocked';

const subscribe = (): (() => void) => () => {};
const serverSnapshot = (): StartupState => 'checking';
let compatibilityRecorded = false;
let recoveryNavigationStarted = false;

function clientSnapshot(): StartupState {
  try {
    return inspectWorkspaceCompatibility(db, localStorage).state === 'compatible'
      ? 'compatible'
      : 'blocked';
  } catch {
    return 'blocked';
  }
}

export function WorkspaceCompatibilityGuard({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const blockedReason =
    state === 'blocked'
      ? (() => {
          try {
            const result = inspectWorkspaceCompatibility(db, localStorage);
            return result.state === 'blocked' ? result.reason : '无法验证工作区兼容性。';
          } catch (error) {
            return `无法验证工作区兼容性：${String(error)}`;
          }
        })()
      : null;

  useEffect(() => {
    if (state === 'checking') return;
    if (state === 'compatible') {
      if (!compatibilityRecorded) {
        compatibilityRecorded = true;
        try {
          recordWorkspaceCompatibility(db);
        } catch {
          compatibilityRecorded = false;
        }
      }
      return;
    }
    if (recoveryNavigationStarted) return;
    recoveryNavigationStarted = true;
    const invoke = getTauriInvoke();
    if (invoke && blockedReason) {
      void invoke('enter_recovery_mode', { reason: blockedReason }).catch(() => {
        recoveryNavigationStarted = false;
      });
    }
  }, [blockedReason, state]);

  if (state === 'checking') return null;
  if (blockedReason) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <section className="w-full max-w-xl">
          <h1 className="text-2xl font-semibold">OpenMAIC Desktop 恢复模式</h1>
          <p className="mt-3 leading-7 text-muted-foreground">{blockedReason}</p>
        </section>
      </main>
    );
  }
  return children;
}
