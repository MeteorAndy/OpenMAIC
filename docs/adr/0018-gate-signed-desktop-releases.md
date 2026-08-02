---
status: accepted
---

# Gate Signed Desktop Releases

A signed Desktop Release can be started only by manually dispatching the workflow for the current `feat/tauri-desktop` head after its complete CI run succeeds and the `desktop-release` GitHub Environment approves deployment. The workflow verifies the Desktop Version, signs and validates the installer, publishes the approved assets, and only then creates the matching `desktop-vX.Y.Z` tag; tags are outputs rather than trusted release triggers, preventing an arbitrary tag or stale commit from bypassing validation and signing approval.
