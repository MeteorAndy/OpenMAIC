---
status: accepted
---

# Keep Recovery Snapshots Portable and Unencrypted

The initial Desktop Release exports `.maic-backup` as an unencrypted, portable Recovery Snapshot containing complete Workspace Data and non-sensitive settings while excluding Provider Credentials. Export requires a clear content warning, and password-based encryption is deferred until a durable encrypted format, password-loss behavior, and long-term restore compatibility can be designed together; this favors dependable recovery while making users responsible for protecting exported files.
