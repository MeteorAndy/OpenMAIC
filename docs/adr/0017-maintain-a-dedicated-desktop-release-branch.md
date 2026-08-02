---
status: accepted
---

# Maintain a Dedicated Desktop Release Branch

`feat/tauri-desktop` is the long-lived integration and release branch for Desktop Edition and periodically absorbs `main`, while desktop-only runtime, installer, and release changes do not flow back into the shared mainline. `feat/saas` remains a separate product branch; this accepts continuing merge maintenance to keep desktop packaging concerns from coupling the Web and SaaS lines.
