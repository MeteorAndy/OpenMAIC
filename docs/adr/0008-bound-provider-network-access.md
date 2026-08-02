---
status: accepted
---

# Bound Provider Network Access Per Endpoint

Desktop Edition permits explicitly local providers to use loopback endpoints by default and permits private-LAN provider endpoints only after per-endpoint user confirmation or allowlisting. Link-local and cloud-metadata destinations, DNS rebinding, and redirects to disallowed destinations remain blocked; this preserves local-provider usability without allowing a global switch to remove the SSRF boundary.
