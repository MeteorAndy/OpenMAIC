import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
const packageVersion = readJson('package.json').version;
const tauriVersion = readJson('src-tauri/tauri.conf.json').version;
const cargoToml = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
const cargoVersion = cargoToml.match(
  /^\[package\][\s\S]*?^name\s*=\s*"openmaic-desktop"[\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];
const lockVersion = cargoLock.match(
  /^\[\[package\]\][\s\S]*?^name\s*=\s*"openmaic-desktop"[\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];

const versions = new Map([
  ['package.json', packageVersion],
  ['src-tauri/tauri.conf.json', tauriVersion],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/Cargo.lock', lockVersion],
]);
for (const [source, version] of versions) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${source} has an invalid Desktop Version: ${String(version)}`);
  }
}
if (new Set(versions.values()).size !== 1) {
  throw new Error(
    `Desktop Version mismatch:\n${[...versions]
      .map(([source, version]) => `  ${source}: ${version}`)
      .join('\n')}`,
  );
}

const requestedVersion = process.env.DESKTOP_RELEASE_VERSION;
if (requestedVersion && requestedVersion !== packageVersion) {
  throw new Error(
    `Requested Desktop Version ${requestedVersion} does not match manifests ${packageVersion}`,
  );
}
if (process.env.DESKTOP_RELEASE === '1' && process.versions.node !== '22.11.0') {
  throw new Error(
    `Desktop releases require Node 22.11.0 exactly; running ${process.versions.node}`,
  );
}

console.log(`[check-desktop-versions] desktop-v${packageVersion} is consistent`);
