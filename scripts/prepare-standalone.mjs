// Assemble Next.js standalone output + static + public into a short staging path.
// Tauri maps it back to resources/server in the installed application.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'src-tauri', 's');

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
const copyOptions = {
  recursive: true,
  // Follow pnpm's node_modules symlinks and copy real files (Windows EPERM on
  // symlink creation without developer mode / admin).
  dereference: true,
  // Next's file tracer drags the whole src-tauri/ tree (Rust target +
  // binaries, 9GB+) into .next/standalone. Exclude it or the bundle balloons.
  // Type declarations and source maps are also compile-time-only; excluding
  // them keeps NSIS below Windows' source-path limit and shrinks the installer.
  filter: (s) =>
    !s.includes('src-tauri') &&
    !s.endsWith('.d.ts') &&
    !s.endsWith('.d.mts') &&
    !s.endsWith('.d.cts') &&
    !s.endsWith('.map') &&
    !s.endsWith('.ts') &&
    !s.endsWith('.tsx') &&
    !s.endsWith('.mts') &&
    !s.endsWith('.cts'),
};

// standalone already includes a traced node_modules + server.js
cpSync(standaloneDir, dest, copyOptions);

// Dereferencing the root Next junction loses pnpm's sibling dependency links.
// Recreate only Next's required dependency tree as standard nested node_modules;
// optional native packages stay excluded.
const nextPackageJson = realpathSync(join(root, 'node_modules', 'next', 'package.json'));
const nextPackageDir = dirname(nextPackageJson);
const nextManifest = JSON.parse(readFileSync(nextPackageJson, 'utf8'));

function packageContext(packageDir, packageName) {
  return packageName.startsWith('@') ? dirname(dirname(packageDir)) : dirname(packageDir);
}

function copyPackageTree(packageName, sourceNodeModules, targetNodeModules, ancestors) {
  const source = realpathSync(join(sourceNodeModules, ...packageName.split('/')));
  if (ancestors.has(source)) return;

  const target = join(targetNodeModules, ...packageName.split('/'));
  mkdirSync(targetNodeModules, { recursive: true });
  cpSync(source, target, copyOptions);

  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const childAncestors = new Set(ancestors).add(source);
  const childSourceNodeModules = packageContext(source, manifest.name);
  const childTargetNodeModules = join(target, 'node_modules');
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    copyPackageTree(dependency, childSourceNodeModules, childTargetNodeModules, childAncestors);
  }
}

const nextSourceNodeModules = packageContext(nextPackageDir, nextManifest.name);
const nextTargetNodeModules = join(dest, 'node_modules', 'next', 'node_modules');
for (const dependency of Object.keys(nextManifest.dependencies || {})) {
  copyPackageTree(
    dependency,
    nextSourceNodeModules,
    nextTargetNodeModules,
    new Set([nextPackageDir]),
  );
}
// standalone does NOT include static or public — copy them in
cpSync(join(root, '.next', 'static'), join(dest, '.next', 'static'), { recursive: true });
cpSync(join(root, 'public'), join(dest, 'public'), { recursive: true });

console.log('[prepare-standalone] assembled server at', dest);
