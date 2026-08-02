---
status: accepted
---

# Snapshot Before Workspace Migration

Desktop Edition must create and validate a local Upgrade Safety Snapshot before any Workspace Data migration that may break backward compatibility. It performs the migration as a rollback-capable operation and restores the snapshot automatically on failure; if snapshot creation or rollback fails, it enters Recovery Mode without permitting further workspace writes, accepting a blocked upgrade rather than risking unrecoverable user data. Only the latest Upgrade Safety Snapshot is retained, and the previous one is removed only after its replacement passes validation; user-exported Recovery Snapshots are never removed automatically.
