/**
 * next/headers shim. The backend never reads cookies — auth is the Bearer
 * header resolved in src/server/auth.ts. This stub exists only so any stray
 * import of `cookies()` resolves instead of failing the bundle; calling it
 * throws, surfacing an unmigrated code path rather than silently no-op'ing.
 */
export interface RequestCookie {
  name: string;
  value: string;
}
export function cookies(): never {
  throw new Error(
    '[backend] next/headers cookies() is not available — auth is Bearer-only. ' +
      'A code path still reaches the Supabase SSR cookie client; override it.',
  );
}
export function headers(): never {
  throw new Error('[backend] next/headers headers() is not available in the compiled backend.');
}
