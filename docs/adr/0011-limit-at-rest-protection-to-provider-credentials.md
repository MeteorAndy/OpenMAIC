---
status: accepted
---

# Limit Application-Level At-Rest Protection to Provider Credentials

The initial Desktop Release protects Provider Credentials with Windows Credential Manager but does not claim application-level encryption for Workspace Data, which relies on Windows account isolation and optional device encryption such as BitLocker. Whole-workspace encryption is deferred until recoverable key management, portable backups, and failure-safe migration can be designed together, avoiding a superficial encryption layer that could make user data permanently unrecoverable.
