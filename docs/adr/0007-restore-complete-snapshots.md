---
status: accepted
---

# Restore Complete Snapshots Deterministically

`.maic-backup` represents a complete Recovery Snapshot, so restoration validates the entire archive, creates a safety snapshot of the current state, and then replaces all Workspace Data and non-sensitive settings through a rollback-capable process. Implicit additive merging is not restoration and will be treated as a separate future import workflow, trading convenience for deterministic disaster recovery.
