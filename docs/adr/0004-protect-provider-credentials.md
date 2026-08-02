---
status: accepted
---

# Protect Provider Credentials with the Operating System

Desktop Edition stores Provider Credentials in Windows Credential Manager and keeps only non-secret provider configuration in WebView storage. Ordinary `.maic-backup` files explicitly exclude credentials, so restoration requires re-entry; migration from existing plaintext storage deletes the old value only after the protected write succeeds, trading seamless portable secrets for a defensible at-rest boundary. If Credential Manager is unavailable or a protected operation fails, Desktop Edition keeps the Active Workspace available in an Offline Session, disables credential-dependent providers, and offers recovery without ever falling back to plaintext storage.
