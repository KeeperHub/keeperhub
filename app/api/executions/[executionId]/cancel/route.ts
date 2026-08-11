import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { resolveAuthorizedExecution } from "@/lib/workflow/execution-access";

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
): Promise<NextResponse> {
  try {
    const { executionId } = await context.params;

    // Cancelling is organization-scoped, so it resolves auth the same way its
    // sibling execution routes do (status, logs, wait) rather than reading the
    // session directly. That admits `kh_` keys, and applies the shared
    // org-membership and soft-delete rules in one place.
    const resolved = await resolveAuthorizedExecution(request, executionId);
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }

    const scopeError = requireScope(resolved.auth.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
    }

    const { execution } = resolved;

    if (execution.status !== "running") {
      return NextResponse.json(
        { error: "Execution is not running" },
        { status: 400 }
      );
    }

    const now = new Date();
    const duration = now.getTime() - execution.startedAt.getTime();

    await db
      .update(workflowExecutions)
      .set({
        status: "cancelled",
        error: "Cancelled by user",
        completedAt: now,
        duration: duration.toString(),
        currentNodeId: null,
        currentNodeName: null,
      })
      .where(eq(workflowExecutions.id, executionId));

    // Mark any in-flight step logs as "error" to prevent orphaned "running" entries
    await db
      .update(workflowExecutionLogs)
      .set({
        status: "cancelled",
        error: "Cancelled by user",
        completedAt: now,
      })
      .where(
        and(
          eq(workflowExecutionLogs.executionId, executionId),
          eq(workflowExecutionLogs.status, "running")
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to cancel execution",
      error,
      { endpoint: "/api/executions/[executionId]/cancel", operation: "post" }
    );
    return NextResponse.json(
      { error: "Failed to cancel execution" },
      { status: 500 }
    );
  }
}
