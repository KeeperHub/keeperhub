import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityAuditLog } from "@/lib/db/schema";

/**
 * Retention window for the security audit trail. MUST match the interval in
 * drizzle/0116_keep_671_audit_append_only.sql, whose trigger only permits
 * deleting rows older than this window (everything newer is immutable). Two
 * years is a common compliance floor for security/forensic logs.
 */
export const AUDIT_RETENTION_DAYS = 730;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The timestamp before which audit rows are eligible for purge. */
export function auditRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * MS_PER_DAY);
}

/**
 * Delete audit rows older than the retention window. The append-only trigger
 * permits exactly these deletions and refuses any newer row, so this is the
 * only path that can remove audit data. Returns the number of rows purged.
 */
export async function purgeExpiredAuditEvents(now: Date): Promise<number> {
  const cutoff = auditRetentionCutoff(now);
  const deleted = await db
    .delete(securityAuditLog)
    .where(lt(securityAuditLog.createdAt, cutoff))
    .returning({ id: securityAuditLog.id });
  return deleted.length;
}
