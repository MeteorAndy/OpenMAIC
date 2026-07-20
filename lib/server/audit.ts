/**
 * Admin audit trail (SaaS, feat/saas) — append-only record of every operator
 * mutation, queryable in the /admin console. Writes are best-effort: an audit
 * failure logs a warning but never fails the business action itself (the
 * action already happened; blocking the response on the log would be worse).
 */
import { db } from '@/db/client';
import { adminAuditLog } from '@/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('Audit');

export type AuditAction = 'subscription.set' | 'user.ban' | 'user.unban' | 'plan.update';
export type AuditTargetType = 'user' | 'plan';

export interface AuditEntry {
  actorUserId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /** Params and/or { before, after } snapshots — anything JSON-serializable. */
  detail?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: crypto.randomUUID(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail ?? null,
    });
  } catch (err) {
    log.warn(
      `audit write failed (${entry.action} on ${entry.targetType}:${entry.targetId}): ${err instanceof Error ? err.message : err}`,
    );
  }
}
