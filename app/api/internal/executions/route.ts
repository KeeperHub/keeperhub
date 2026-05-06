import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { recordBlockedWorkflowExecution } from "@/lib/billing/record-blocked-execution";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json();
  const { workflowId, userId, input } = body;

  if (!(workflowId && userId)) {
    return NextResponse.json(
      { error: "workflowId and userId are required" },
      { status: 400 }
    );
  }

  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
    columns: { organizationId: true },
  });

  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  const executionGuard = await enforceExecutionLimit(workflow.organizationId);
  if (executionGuard.blocked) {
    await recordBlockedWorkflowExecution({
      workflowId,
      userId,
      triggerType: "internal",
      limitResult: executionGuard.limitResult,
      input: input ?? undefined,
    });
    return executionGuard.response;
  }

  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId,
      userId,
      status: "running",
      input: input || {},
    })
    .returning({ id: workflowExecutions.id });

  return NextResponse.json({ executionId: execution.id }, { status: 201 });
}
