/**
 * Security audit-log retention cron. Purges audit rows older than
 * AUDIT_RETENTION_DAYS. The append-only trigger on security_audit_log only
 * permits deleting rows past that window, so this job is the sole path that
 * can remove audit data and it can only ever remove already-expired rows.
 *
 * Deployment: invoked by an external scheduler (Kubernetes CronJob), e.g.
 * daily. Authorized via `Authorization: Bearer $CRON_SECRET`, mirroring the
 * other cron routes. Fails closed when CRON_SECRET is unset; no NODE_ENV
 * bypass.
 */

import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  AUDIT_RETENTION_DAYS,
  purgeExpiredAuditEvents,
} from "@/lib/security/audit-retention";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const purged = await purgeExpiredAuditEvents(new Date());
    return Response.json({ purged, retentionDays: AUDIT_RETENTION_DAYS });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to purge expired audit events",
      error,
      { endpoint: "/api/cron/audit-retention" }
    );
    return Response.json({ error: "purge failed" }, { status: 500 });
  }
}
