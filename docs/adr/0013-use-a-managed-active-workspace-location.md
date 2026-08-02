---
status: accepted
---

# Use a Managed Active Workspace Location

The initial Desktop Release stores the Active Workspace in a fixed per-user application data location managed by Desktop Edition and does not support relocating it to custom, network, or removable storage. Recovery Snapshots may still be exported anywhere the user chooses; this accepts less storage-placement flexibility to avoid disconnect, permission, locking, and upgrade-consistency failures in the live workspace.
