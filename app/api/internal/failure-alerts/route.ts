/**
 * Once-a-minute failure alert cycle, called by the `failure-alerts` CronJob (HMAC).
 * Overlapping replicas are safe (SKIP LOCKED); failed stages answer 500.
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
