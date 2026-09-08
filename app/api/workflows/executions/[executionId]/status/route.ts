import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import {
  isErrorStatus,
  type NodeExecutionStatus,
} from "@/lib/errors/execution-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import { HttpStatus } from "@/lib/http-status";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import {
  type AuthorizedExecution,
  type ExecutionStatusPayload,
  redactExecutionStatusForPublicView,
  resolveExecutionViewAccess,
} from "@/lib/workflow/execution-access";
import { executionLogNotDeleted } from "@/lib/workflow/soft-delete";
import { checkExecutionStatusRateLimit } from "@/lib/workflow/execution-status-rate-limit";

type NodeStatus = {
  nodeId: string;
  status: NodeExecutionStatus;
};

// Statuses after which there is nothing left to poll for. Mirrors the set the
// share view stops on (components/executions/execution-share-view.tsx).
const TERMINAL_STATUSES = new Set([
  "success",
  "error",
  "system_error",
  "skipped",
  "cancelled",
]);
const POLL_INTERVAL_HINT_SECONDS = 2;

function buildStatusPayload(
  execution: AuthorizedExecution,
  nodeStatuses: NodeStatus[]
): ExecutionStatusPayload {
  const runningCount = nodeStatuses.filter((n) => n.status === "running").length;
  const totalSteps = Number.parseInt(execution.totalSteps || "0", 10);
  const completedSteps = Number.parseInt(execution.completedSteps || "0", 10);

  return {
    status: execution.status,
    nodeStatuses,
    progress: {
      totalSteps,
      completedSteps,
      runningSteps: runningCount,
      currentNodeId: execution.currentNodeId,
      currentNodeName: execution.currentNodeName,
      percentage:
        totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    },
    errorContext: isErrorStatus(execution.status)
      ? {
          failedNodeId: execution.currentNodeId,
          lastSuccessfulNodeId: execution.lastSuccessfulNodeId,
          lastSuccessfulNodeName: execution.lastSuccessfulNodeName,
          executionTrace: execution.executionTrace,
          error: execution.error,
        }
      : null,
    transactionHashes: execution.transactionHashes,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const timer = createTimer();

  try {
    const { executionId } = await context.params;

    // Resolved once and threaded through both the limiter and the access
    // check: this is the hottest endpoint in the app, and each extra
    // resolution is another api-key/session lookup plus a last_used_at write.
    const authContext = await getDualAuthContext(request, { required: false });

    const rateLimit = checkExecutionStatusRateLimit(request, authContext);
    if (!rateLimit.allowed) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
      });
      const response = NextResponse.json(
        { error: "Too many requests" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      );
      return applyRateLimitHeaders(response, rateLimit);
    }

    const viewAccess = await resolveExecutionViewAccess(
      request,
      executionId,
      authContext
    );
    if (viewAccess.mode === "invalidAuth") {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 401,
      });
      return NextResponse.json({ error: viewAccess.error }, { status: 401 });
    }
    if (viewAccess.mode === "notFound") {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 404,
      });
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }
    if (viewAccess.mode === "accessDenied") {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 403,
      });
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { execution } = viewAccess;

    const logs = await db.query.workflowExecutionLogs.findMany({
      // Per-step detail of one run, so a purge hides it here too.
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        executionLogNotDeleted()
      ),
    });

    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status: log.status,
    }));

    let payload = buildStatusPayload(execution, nodeStatuses);
    if (viewAccess.mode === "publicReadOnly") {
      payload = redactExecutionStatusForPublicView(payload);
    }

    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 200,
      executionStatus: execution.status,
    });

    // Budget headers belong on the success path too, not just the denial: a
    // poller that can only learn its remaining budget from the response that
    // already rejected it has no way to slow down before hitting the wall.
    return applyRateLimitHeaders(NextResponse.json(payload), rateLimit, {
      pollIntervalHint: TERMINAL_STATUSES.has(execution.status)
        ? 0
        : POLL_INTERVAL_HINT_SECONDS,
    });
  } catch (error) {
    const { executionId } = await context.params;
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get execution status",
      error,
      {
        endpoint: "/api/workflows/executions/[executionId]/status",
        operation: "get",
      }
    );
    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 500,
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution status",
      },
      { status: 500 }
    );
  }
}
