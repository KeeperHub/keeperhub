import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { authFailureResponse, getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { db } from "@/lib/db";
import { workflowExecutions, workflowHistory, workflows } from "@/lib/db/schema";
import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  executionLogNotDeleted,
  executionLogSoftDeleteValues,
} from "@/lib/workflow/soft-delete";

function parseIntOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }
    const { userId, organizationId } = authContext;

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Fetch executions, excluding runs whose history was purged.
    const executions = await db.query.workflowExecutions.findMany({
      where: and(
        eq(workflowExecutions.workflowId, workflowId),
        isNull(workflowExecutions.deletedAt)
      ),
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: 50,
    });

    // Resolve the workflow version each run executed: the run carries the
    // content hash of the definition it ran (executed_workflow_hash), which
    // joins to workflow_history.content_hash. Looked up in one batched query.
    const ranHashes = [
      ...new Set(
        executions.map((e) => e.executedWorkflowHash).filter(Boolean)
      ),
    ] as string[];
    const historyRows =
      ranHashes.length > 0
        ? await db
            .select({
              version: workflowHistory.version,
              contentHash: workflowHistory.contentHash,
              createdAt: workflowHistory.createdAt,
            })
            .from(workflowHistory)
            .where(
              and(
                eq(workflowHistory.workflowId, workflowId),
                inArray(workflowHistory.contentHash, ranHashes)
              )
            )
        : [];
    // A content hash usually maps to exactly one version; a revert can make two
    // versions share it. In that case pick the version that was in effect when
    // the run started (the highest version created at or before startedAt).
    const resolveVersion = (
      hash: string | null,
      startedAt: Date | null
    ): number | null => {
      if (!hash) {
        return null;
      }
      const candidates = historyRows.filter((h) => h.contentHash === hash);
      if (candidates.length <= 1) {
        return candidates[0]?.version ?? null;
      }
      const at = startedAt ?? new Date(0);
      const eligible = candidates.filter((c) => c.createdAt <= at);
      const pool = eligible.length > 0 ? eligible : candidates;
      return pool.reduce((best, c) => (c.version > best.version ? c : best))
        .version;
    };

    // KEEP-481: `total_steps` and `completed_steps` are stored as TEXT and
    // Drizzle returns them as strings, which leaks into the response as
    // string-or-null and breaks type-checked SDK clients (Pydantic, Zod, Go).
    // Coerce to `number | null` before serializing so the response matches the
    // numeric shape clients expect; non-numeric strings (shouldn't happen) fall
    // through as null rather than NaN.
    const serialized = executions.map((execution) => ({
      ...execution,
      totalSteps: parseIntOrNull(execution.totalSteps),
      completedSteps: parseIntOrNull(execution.completedSteps),
      ranVersion: resolveVersion(
        execution.executedWorkflowHash,
        execution.startedAt
      ),
    }));

    return NextResponse.json(serialized);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get executions", error, {
      endpoint: "/api/workflows/[workflowId]/executions",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get executions",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return authFailureResponse(authContext, request.headers);
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const { userId, organizationId } = authContext;

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Only the runs not already purged; keeps deletedCount accurate on re-runs.
    const executions = await db.query.workflowExecutions.findMany({
      where: and(
        eq(workflowExecutions.workflowId, workflowId),
        isNull(workflowExecutions.deletedAt)
      ),
      columns: { id: true },
    });

    const executionIds = executions.map((e) => e.id);

    if (executionIds.length > 0) {
      const { workflowExecutionLogs } = await import("@/lib/db/schema");
      const purgedAt = new Date();

      // Soft-delete the per-step logs. They carry the per-network gas the
      // analytics breakdown aggregates, so erasing them leaves a gap the
      // org-level total does not share and nothing can reconcile.
      await db
        .update(workflowExecutionLogs)
        .set(executionLogSoftDeleteValues(purgedAt))
        .where(
          and(
            inArray(workflowExecutionLogs.executionId, executionIds),
            executionLogNotDeleted()
          )
        );

      // Soft-delete the runs themselves: usage counters count every row, so the
      // billing total cannot be reset by purging history. Listings filter
      // deleted_at IS NULL.
      await db
        .update(workflowExecutions)
        .set({ deletedAt: purgedAt })
        .where(inArray(workflowExecutions.id, executionIds));
    }

    return NextResponse.json({
      success: true,
      deletedCount: executionIds.length,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to delete executions",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/executions",
        operation: "delete",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete executions",
      },
      { status: 500 }
    );
  }
}
