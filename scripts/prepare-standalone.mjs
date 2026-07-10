// Assemble Next.js standalone output + static + public into src-tauri/resources/server/
// so the Rust sidecar can spawn node server.js from a fixed path.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'src-tauri', 'resources', 'server');

if (existsSync(dest)) cpSync(dest, `${dest}.bak`, { recursive: true });
mkdirSync(dest, { recursive: true });

// standalone already includes a traced node_modules + server.js
cpSync(join(root, '.next', 'standalone'), dest, { recursive: true });
// standalone does NOT include static or public — copy them in
cpSync(join(root, '.next', 'static'), join(dest, '.next', 'static'), { recursive: true });
cpSync(join(root, 'public'), join(dest, 'public'), { recursive: true });

console.log('[prepare-standalone] assembled server at', dest);
