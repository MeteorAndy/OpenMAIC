export interface TauriGlobal {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export function getTauriInvoke(): TauriGlobal['core']['invoke'] | null {
  return typeof window === 'undefined' ? null : (window.__TAURI__?.core.invoke ?? null);
}
