/**
 * Workflow failure notifications: the once-a-minute cycle.
 *
 * Evaluates workflows whose runs ended since the last cycle, opens and
 * resolves incidents, sends what is due with retries and backups, and runs the
 * weekly silent channel checks. Authenticated as an internal service (HMAC)
 * and invoked by the `failure-alerts` k8s CronJob via deploy/scripts/reaper.sh
 * with concurrencyPolicy Forbid. Replicas can still overlap during a deploy,
 * which is safe: every claim in the cycle uses SKIP LOCKED or a unique row.
 *
 * A cycle whose stages failed answers 500, so the CronJob fails and our
 * alerting on failed jobs sees it; the report still says what did run.
 */
import { NextResponse } from "next/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { runFailureAlertCycle } from "@/lib/notifications/failure-alerts/cycle";
import { appBaseUrl } from "@/lib/notifications/failure-alerts/messages";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  try {
    const report = await runFailureAlertCycle(appBaseUrl());
    return NextResponse.json(report, {
      status: report.errors.length > 0 ? 500 : 200,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[FailureAlerts] Cycle failed",
      error,
      { endpoint: "/api/internal/failure-alerts", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failure alert cycle failed" },
      { status: 500 }
    );
  }
}
