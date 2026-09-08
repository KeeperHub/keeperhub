import { and, eq, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { type ErrorCode, getErrorCodeEntry } from "@/lib/errors/error-codes";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { isErrorStatus } from "@/lib/errors/execution-status";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory } from "@/lib/logging";
import { recordWorkflowExecutionFinished } from "@/lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "@/lib/metrics/metric-constants";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const { executionId } = await context.params;
  const body = JSON.parse(rawBody);
  const { status, error, duration, errorCode } = body;

  type ExecutionStatus = "running" | "success" | "error" | "system_error";
  const validStatuses: ExecutionStatus[] = [
    "running",
    "success",
    "error",
    "system_error",
  ];

  // Validate status
  if (!(status && validStatuses.includes(status))) {
    return NextResponse.json(
      {
        error:
          "status must be 'running', 'success', 'error', or 'system_error'",
      },
      { status: 400 }
    );
  }

  // Optional system error code (PREFIX-NNNN). When present it must be a known
  // registry code; the matching category/type are derived from it so the row
  // stays consistent with classifier-written error rows.
  let codeEntry: ReturnType<typeof getErrorCodeEntry> = null;
  if (errorCode !== undefined && errorCode !== null) {
    codeEntry = getErrorCodeEntry(errorCode);
    if (!codeEntry) {
      return NextResponse.json({ error: "Invalid errorCode" }, { status: 400 });
    }
  }

  const typedStatus = status as ExecutionStatus;

  // Check execution exists and is not already cancelled
  const existing = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: { id: true, status: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Execution not found" }, { status: 404 });
  }

  // Don't overwrite cancelled status (user already stopped this execution)
  if (existing.status === "cancelled") {
    return NextResponse.json({ success: true });
  }

  // Build update payload
  const isError = isErrorStatus(status);
  const isTerminal = status === "success" || isError;
  const updateData: {
    status: ExecutionStatus;
    error?: string | null;
    errorCode?: ErrorCode;
    errorType?: ExecutionErrorType;
    errorCategory?: ErrorCategory;
    completedAt?: Date;
    duration?: string;
    currentNodeId?: null;
    currentNodeName?: null;
  } = { status: typedStatus };

  if (isError) {
    updateData.error = error || "Unknown error";
    updateData.completedAt = new Date();
    if (codeEntry) {
      updateData.errorCode = codeEntry.code;
      updateData.errorType = ExecutionErrorType.SYSTEM;
      updateData.errorCategory = codeEntry.category;
    } else if (status === "system_error") {
      // A system_error row must carry the system classification even when the
      // caller did not supply a registry code, so downstream readers that
      // assume status='system_error' implies errorType='system' stay consistent.
      updateData.errorType = ExecutionErrorType.SYSTEM;
      updateData.errorCategory = ErrorCategory.INFRASTRUCTURE;
    }
  } else if (status === "success") {
    updateData.completedAt = new Date();
  }

  if (isTerminal) {
    updateData.currentNodeId = null;
    updateData.currentNodeName = null;
    if (typeof duration === "string") {
      updateData.duration = duration;
    }
  }

  // Self-join alias exposing the pre-update status (the FROM clause reads the
  // statement snapshot) so the terminal counters below emit only on the first
  // non-terminal -> terminal transition. This route is a real terminal writer
  // (scheduler/event-tracker phantom resolution marks enqueue failures as
  // system_error here) that bypasses every other counted finalize path.
  const prevExecution = alias(workflowExecutions, "prev_execution");

  const updated = await db
    .update(workflowExecutions)
    .set(updateData)
    .from(prevExecution)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(prevExecution.id, workflowExecutions.id),
        notInArray(workflowExecutions.status, ["cancelled", "skipped"])
      )
    )
    .returning({
      workflowId: workflowExecutions.workflowId,
      previousStatus: prevExecution.status,
    });

  const previousStatus = updated[0]?.previousStatus;
  const wasNonTerminal =
    previousStatus !== undefined &&
    previousStatus !== "success" &&
    !isErrorStatus(previousStatus);

  if (updated.length > 0 && isTerminal && wasNonTerminal) {
    const workflowId = updated[0].workflowId;
    if (isError) {
      await recordExecutionErrorFinalized({
        workflowId,
        errorMessage: updateData.error,
        persistedStatus:
          typedStatus === "system_error" ? "system_error" : "error",
        errorCategory: updateData.errorCategory,
      });
    } else {
      try {
        recordWorkflowExecutionFinished({
          status: "success",
          orgSlug: await resolveOrgSlugForCounter(workflowId),
          errorType: NA_ERROR_TYPE,
        });
      } catch {
        // Counter emission must never fail the status write.
      }
    }
  }

  return NextResponse.json({ success: true });
}
