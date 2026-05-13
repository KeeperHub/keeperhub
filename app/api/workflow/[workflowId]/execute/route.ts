import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { getMetricsCollector } from "@/lib/metrics";
import { isTriggerType, LabelKeys, MetricNames, type TriggerType } from "@/lib/metrics/types";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { getOrgPlanLabel, getOrgSlug } from "@/lib/db/org-helpers";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

async function executeWorkflowBackground(
  executionId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  input: Record<string, unknown>,
  organizationId?: string | null,
  ownerId?: string,
  organizationSlug?: string,
  organizationPlan?: string
): Promise<void> {
  try {
    console.log("[Workflow Execute] Starting execution:", executionId);

    // SECURITY: We pass only the workflowId as a reference
    // Steps will fetch credentials internally using fetchWorkflowCredentials(workflowId)
    // This prevents credentials from being logged in workflow observability output
    console.log("[Workflow Execute] Calling executeWorkflow with:", {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hasExecutionId: !!executionId,
      workflowId,
    });

    // Use start() from workflow/api to properly execute the workflow
    const run = await start(executeWorkflow, [
      {
        nodes,
        edges,
        triggerInput: input,
        executionId,
        workflowId,
        organizationId: organizationId ?? undefined,
        ownerId,
        organizationSlug,
        organizationPlan,
      },
    ]);

    console.log("[Workflow Execute] Workflow started, runId:", run.runId);

    await db
      .update(workflowExecutions)
      .set({ runId: run.runId })
      .where(eq(workflowExecutions.id, executionId));
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Workflow Execute] Error during execution", error, { endpoint: "/api/workflow/[workflowId]/execute", operation: "executeWorkflow" });

    // Update execution record with error
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Workflow execution requires complex error handling and validation
export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Check for internal service authentication (MCP, Events, Scheduler)
    const internalAuth = authenticateInternalService(request);
    const isInternalExecution = internalAuth.authenticated;

    let userId: string;
    let workflow: typeof workflows.$inferSelect | undefined;

    if (isInternalExecution) {
      // Internal execution from authenticated service
      console.log(
        `[Workflow Execute] Internal execution from service: ${internalAuth.service}`
      );

      workflow = await db.query.workflows.findFirst({
        where: eq(workflows.id, workflowId),
      });

      if (!workflow) {
        return NextResponse.json(
          { error: "Workflow not found" },
          { status: 404 }
        );
      }

      userId = workflow.userId;
    } else {
      const authContext = await getDualAuthContext(request);
      if ("error" in authContext) {
        return NextResponse.json(
          { error: authContext.error },
          { status: authContext.status }
        );
      }

      workflow = await db.query.workflows.findFirst({
        where: eq(workflows.id, workflowId),
      });

      if (!workflow) {
        return NextResponse.json(
          { error: "Workflow not found" },
          { status: 404 }
        );
      }

      const isOwner = authContext.authMethod === "session" && workflow.userId === authContext.userId;
      const isSameOrg =
        !workflow.isAnonymous &&
        workflow.organizationId &&
        authContext.organizationId === workflow.organizationId;

      if (!(isOwner || isSameOrg)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      userId = authContext.userId ?? workflow.userId;
    }

    // Validate that all integrationIds in workflow nodes belong to the user or org
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      userId,
      workflow.organizationId
    );
    if (!validation.valid) {
      logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Workflow Execute] Invalid integration references", new Error(String(validation.invalidIds)), { endpoint: "/api/workflow/[workflowId]/execute", operation: "validateIntegrations" });
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403 }
      );
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      return executionGuard.response;
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      return NextResponse.json(
        {
          error: "Too many concurrent workflow executions",
          running: concurrencyCheck.running,
          limit: concurrencyCheck.limit,
        },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const input = body.input || {};

    // Check if executionId was provided (for scheduled executions)
    // This allows the executor to pre-create the execution record
    let executionId = body.executionId;
    // Whether this request created the workflow_executions row itself, vs.
    // reusing one that the executor pre-created. The KEEP-556 counter only
    // increments here when we created the row, so the executor-side increment
    // and this one never double-count.
    let createdHere = false;

    if (executionId) {
      // Verify execution exists and is in running state
      const existingExecution = await db.query.workflowExecutions.findFirst({
        where: eq(workflowExecutions.id, executionId),
      });

      if (existingExecution) {
        // Use existing execution
        console.log("[API] Using existing execution:", executionId);
      } else {
        // Create new execution with provided ID
        await db.insert(workflowExecutions).values({
          id: executionId,
          workflowId,
          userId,
          status: "running",
          input,
        });
        console.log("[API] Created execution with provided ID:", executionId);
        createdHere = true;
      }
    } else {
      // Create new execution record
      const [execution] = await db
        .insert(workflowExecutions)
        .values({
          workflowId,
          userId,
          status: "running",
          input,
        })
        .returning();

      executionId = execution.id;
      console.log("[API] Created execution:", executionId);
      createdHere = true;
    }

    // Record per-(trigger_type, chain) start of a workflow execution. Drives the
    // Grafana "zero executions in N min" alert family (see KEEP-556). The
    // trigger type is carried by the caller via the X-Trigger-Type header so
    // internal callers can mark precise sources (block / schedule / event); we
    // fall back to the legacy "scheduled" / "manual" defaults if the header is
    // absent or invalid. Skipped when the executor pre-created the row - it
    // already incremented on its side in that case.
    if (createdHere) {
      const headerTrigger = request.headers.get("x-trigger-type");
      const triggerType: TriggerType = isTriggerType(headerTrigger)
        ? headerTrigger
        : isInternalExecution
          ? "scheduled"
          : "manual";
      const chainLabel = workflow.chain ?? "_unknown";
      const metrics = getMetricsCollector();
      metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL, {
        [LabelKeys.TRIGGER_TYPE]: triggerType,
        [LabelKeys.CHAIN]: chainLabel,
      });
    }

    // Resolve org slug + plan for log labels (cached per request)
    const [organizationSlug, organizationPlan] = await Promise.all([
      getOrgSlug(workflow.organizationId),
      getOrgPlanLabel(workflow.organizationId),
    ]);

    // Execute the workflow in the background (don't await)
    executeWorkflowBackground(
      executionId,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      input,
      workflow.organizationId,
      workflow.userId,
      organizationSlug,
      organizationPlan
    );

    // Return immediately with the execution ID
    return NextResponse.json({
      executionId,
      status: "running",
    });
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "Failed to start workflow execution", error, { endpoint: "/api/workflow/[workflowId]/execute", operation: "post" });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start workflow execution",
      },
      { status: 500 }
    );
  }
}
