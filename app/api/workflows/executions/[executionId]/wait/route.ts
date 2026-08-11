import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import {
  DEFAULT_CALL_WAIT_TIMEOUT_MS,
  waitForExecutionReceipt,
} from "@/lib/payments/x402/execution-wait";
import { resolveAuthorizedExecution } from "@/lib/workflow/execution-access";

// Cap how long a single request blocks so it stays under typical HTTP/MCP
// client timeouts and never pins a serverless worker indefinitely. Clients
// re-call to keep waiting past this window.
const MAX_WAIT_TIMEOUT_MS = 60_000;

function parseTimeoutMs(request: Request): number {
  const raw = new URL(request.url).searchParams.get("timeoutMs");
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CALL_WAIT_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, 0), MAX_WAIT_TIMEOUT_MS);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const timer = createTimer();

  try {
    const { executionId } = await context.params;

    const resolved = await resolveAuthorizedExecution(request, executionId);
    if (!resolved.ok) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: resolved.status,
      });
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }

    const timeoutMs = parseTimeoutMs(request);
    const { row, completed } = await waitForExecutionReceipt(
      executionId,
      timeoutMs
    );

    if (!row) {
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

    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 200,
      executionStatus: row.status,
    });

    // completed is false on timeout (still pending/running), true once the
    // execution reached a terminal state within the wait window.
    return NextResponse.json({
      executionId,
      status: row.status,
      completed,
      transactionHashes: row.transactionHashes ?? [],
      output: row.output,
      error: row.error ?? null,
      gasUsedWei: row.gasUsedWei,
      completedAt: row.completedAt,
    });
  } catch (error) {
    const { executionId } = await context.params;
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to wait for execution receipt",
      error,
      {
        endpoint: "/api/workflows/executions/[executionId]/wait",
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
            : "Failed to wait for execution receipt",
      },
      { status: 500 }
    );
  }
}
