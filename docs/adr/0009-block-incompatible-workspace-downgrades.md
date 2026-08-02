---
status: accepted
---

# Block Incompatible Workspace Downgrades

Desktop Edition records compatibility metadata for Workspace Data and checks it before the Local Service can read or migrate that data. An older version may proceed only when the recorded compatibility range explicitly permits it; otherwise it preserves the workspace unchanged and enters Recovery Mode, trading downgrade convenience for protection against silent corruption by older code.
