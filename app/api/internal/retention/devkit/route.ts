import { NextResponse } from "next/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { runDevkitRetentionPurge } from "@/lib/retention/purge-devkit-runs";

export const dynamic = "force-dynamic";

/**
 * GET /api/internal/retention/devkit
 *
 * Delete finished Workflow DevKit runs past the retention window, with their
 * steps and events. The response reports the counts per table, so a dry run
 * is usable as the pre-flight check before the job deletes for real.
 *
 * Called by the `retention-devkit` K8s CronJob through
 * deploy/scripts/reaper.sh, which signs the request and fails the job on any
 * non-2xx. Authorized by the same internal-service HMAC scheme every other
 * scheduled route uses.
 *
 * The job is off until DEVKIT_RETENTION_ENABLED is set, so deploying this
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
    return NextResponse.json(await runDevkitRetentionPurge());
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[DevKit Retention] Failed to purge expired DevKit runs",
      error,
      { endpoint: "/api/internal/retention/devkit", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to purge expired DevKit runs",
      },
      { status: 500 }
    );
  }
}
