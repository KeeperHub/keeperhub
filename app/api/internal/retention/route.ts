import { NextResponse } from "next/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  recordRetentionRowsPurged,
  recordRetentionRun,
  recordRetentionWindow,
} from "@/lib/metrics/collectors/prometheus";
import { runRetentionPurge } from "@/lib/retention/purge-executions";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/retention
 *
 * KEEP-1042: age out workflow execution data. Deletes step logs at the window
 * the owning org's plan sells, nulls `output_raw` once a run can no longer
 * resume, and hard-deletes step logs a user already purged. Retiring run rows
 * is a separate pass behind a switch of its own, off until a durable per-period
 * usage record exists, because the invoices page recounts that table live.
 *
 * The response reports each pass separately and, for the plan-window pass, the
 * organization count and rows per window. A dry run is therefore usable as the
 * pre-flight check that every organization resolved to the window it pays for.
 *
 * Called by the `retention` K8s CronJob through deploy/scripts/reaper.sh, which
 * signs the request and fails the job on any non-2xx. Authorized by the same
 * internal-service HMAC scheme every other scheduled route uses.
 *
 * The job is off until EXECUTION_RETENTION_ENABLED is set, so deploying this
 * route changes nothing on its own.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  try {
    const result = await runRetentionPurge();

    if (result.enabled && !result.dryRun) {
      for (const pass of result.passes) {
        recordRetentionRowsPurged(pass.pass, pass.rows);
        for (const window of pass.windows ?? []) {
          recordRetentionWindow(
            window.retentionDays,
            window.organizationCount,
            window.rows
          );
        }
      }
      recordRetentionRun("success");
    }

    return NextResponse.json(result);
  } catch (error) {
    recordRetentionRun("failure");
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to purge expired execution data",
      error,
      { endpoint: "/api/internal/retention", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to purge expired execution data",
      },
      { status: 500 }
    );
  }
}
