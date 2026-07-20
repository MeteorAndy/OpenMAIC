/**
 * Admin gate (SaaS, feat/saas).
 *
 * Skeleton admin authz: a deployment-level allowlist of user ids in env, no
 * schema change. `ADMIN_USER_IDS=<uuid>,<uuid>,...`. Used by the compiled
 * backend's /api/admin/* routes and by the Next /admin page guard.
 * Replace with a role column when the admin surface outgrows this.
 */
export function isAdmin(userId: string): boolean {
  const raw = process.env.ADMIN_USER_IDS;
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId);
}
