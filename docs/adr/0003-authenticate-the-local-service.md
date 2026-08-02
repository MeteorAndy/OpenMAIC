---
status: accepted
---

# Authenticate the Local Service

The Local Service remains bound to loopback but also requires a fresh credential created by its owning Desktop Instance and validates request origin for every API except the minimal health check. Loopback binding alone does not authenticate callers, so requests from unrelated local processes, browser pages, or network devices must be rejected even though this adds credential bootstrapping to desktop startup.
