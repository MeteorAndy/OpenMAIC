---
status: accepted
---

# Version Desktop Edition Independently

Desktop Edition uses an independent `desktop-vX.Y.Z` release sequence because the repository's existing `vX.Y.Z` tags belong to the Web product. The root package manifest, Tauri configuration, and Cargo package must carry the same Desktop Version and CI rejects drift between them; the initial candidate is `0.1.0`, avoiding ambiguous artifacts and tag collisions while accepting a separate version line to maintain.
