/**
 * Security audit-log retention cron. Purges audit rows older than
 * AUDIT_RETENTION_DAYS. The append-only trigger on security_audit_log only
 * permits deleting rows past that window, so this job is the sole path that
 * can remove audit data and it can only ever remove already-expired rows.
 *
 * Deployment: intended for a Kubernetes CronJob (e.g. daily) that runs
 * `deploy/scripts/reaper.sh` against this path, the same way the other cron
 * routes are scheduled. No CronJob is defined for it yet: scheduling a
 * retention deletion is a product decision that has not been taken.
 * Authorized via the internal-service HMAC scheme (`X-KH-Caller`,
 * `X-KH-Timestamp`, `X-KH-Signature` signed with
 * `INTERNAL_SERVICE_HMAC_SECRET`) through `authenticateInternalService`. Fails
 * closed when the signature does not verify; there is no NODE_ENV bypass.
 */

import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  AUDIT_RETENTION_DAYS,
  purgeExpiredAuditEvents,
} from "@/lib/security/audit-retention";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return Response.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
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
