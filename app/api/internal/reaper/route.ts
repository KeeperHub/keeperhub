import { NextResponse } from "next/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { reapStaleExecutions } from "@/lib/reaper/reap-stale-executions";

/**
 * GET /api/internal/reaper
 *
 * Finds workflow executions stuck past their threshold and marks them as
 * system_error with a timeout classification.
 *
 * Intended to be called by an external cron job (K8s CronJob).
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
    const reapedIds = await reapStaleExecutions();
    return NextResponse.json({
      reapedCount: reapedIds.length,
      reapedIds,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to reap stale executions",
      error,
      { endpoint: "/api/internal/reaper", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reap stale executions",
      },
      { status: 500 }
    );
  }
}
