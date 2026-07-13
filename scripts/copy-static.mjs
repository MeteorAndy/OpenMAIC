// Next standalone (.next/standalone/server.js) does NOT include .next/static
// (CSS/JS chunks) or public/ — copy them in so the dev sidecar (server_path =
// .next/standalone/server.js) can serve them. Release uses prepare-standalone.mjs
// (→ resources/server); this is the dev-only equivalent that writes under .next/
// (outside src-tauri/, so no cargo file-watcher rebuild loop).
import { cpSync } from 'node:fs';

cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
cpSync('public', '.next/standalone/public', { recursive: true });
console.log('[copy-static] .next/static + public -> .next/standalone');
