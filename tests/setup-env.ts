/**
 * Load .env.local before tests so API keys are available.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Node 24 exposes a native navigator.locks. Tests target the browser fallback
// unless they inject a lock manager explicitly.
if (
  typeof window === 'undefined' &&
  typeof navigator !== 'undefined' &&
  navigator.userAgent.startsWith('Node.js')
) {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
}

const envPath = resolve(__dirname, '..', '.env.local');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.local not found, skip
}
