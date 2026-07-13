// Assemble Next.js standalone output + static + public into src-tauri/resources/server/
// so the Rust sidecar can spawn node server.js from a fixed path.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'src-tauri', 'resources', 'server');

// Rebuild dest clean each run. The old backup-then-merge left a multi-GB stale
// blob (whole repo copied) when .next/standalone was empty.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// Fail loudly instead of silently shipping stale content.
const standaloneDir = join(root, '.next', 'standalone');
if (!existsSync(join(standaloneDir, 'server.js'))) {
  console.error('[prepare-standalone] .next/standalone/server.js missing — run `pnpm build` first');
  process.exit(1);
}
// standalone already includes a traced node_modules + server.js
cpSync(standaloneDir, dest, {
  recursive: true,
  // Follow pnpm's node_modules symlinks and copy real files (Windows EPERM on
  // symlink creation without developer mode / admin).
  dereference: true,
  // Next's file tracer drags the whole src-tauri/ tree (Rust target +
  // binaries, 9GB+) into .next/standalone. Exclude it or the bundle balloons.
  filter: (s) => !s.includes('src-tauri'),
});
// standalone does NOT include static or public — copy them in
cpSync(join(root, '.next', 'static'), join(dest, '.next', 'static'), { recursive: true });
cpSync(join(root, 'public'), join(dest, 'public'), { recursive: true });

console.log('[prepare-standalone] assembled server at', dest);
