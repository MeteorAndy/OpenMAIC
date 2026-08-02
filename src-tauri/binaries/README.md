# Tauri sidecar binaries

Tauri's `externalBin` (`binaries/node` in `tauri.conf.json`) resolves a
platform-specific binary at bundle time by appending the Rust target triple:

| Platform | Expected filename |
| --- | --- |
| Windows x86_64 | `node-x86_64-pc-windows-msvc.exe` |
| macOS arm64 | `node-aarch64-apple-darwin` |
| macOS x64 | `node-x86_64-apple-darwin` |
| Linux x64 | `node-x86_64-unknown-linux-gnu` |

These binaries are gitignored (~30–80 MB each). Download the one for your
platform before running `cargo build` / `tauri dev`.

## Windows (current MVP target)

```powershell
# From the repository root. The script verifies the pinned SHA-256 before use.
./scripts/prepare-windows-sidecar.ps1
```

Pin Node v22.x to match the Next.js standalone runtime. Bump the patch
version together with the standalone build when upgrading.
