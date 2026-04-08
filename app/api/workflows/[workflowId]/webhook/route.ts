import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import {
  createTimer,
  getMetricsCollector,
} from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import {
  EXECUTION_LIMIT_ERROR,
  enforceExecutionLimit,
} from "@/lib/billing/execution-guard";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { recordWebhookMetrics } from "@/lib/metrics/instrumentation/api";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { apiKeys, workflowExecutions, workflows } from "@/lib/db/schema";
import { getOrgSlug } from "@/lib/db/org-helpers";
import { executeWorkflow } from "@/lib/workflow-executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
// Validate API key and return the user ID if valid
async function validateApiKey(
  authHeader: string | null,
  workflowUserId: string
): Promise<{ valid: boolean; error?: string; statusCode?: number }> {
  if (!authHeader) {
    return {
      valid: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  // Support "Bearer <key>" format
  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key?.startsWith("wfb_")) {
    return { valid: false, error: "Invalid API key format", statusCode: 401 };
  }

  // Hash the key to compare with stored hash
  const keyHash = createHash("sha256").update(key).digest("hex");

  // Find the API key in the database
  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!apiKey) {
    return { valid: false, error: "Invalid API key", statusCode: 401 };
  }

  // Verify the API key belongs to the workflow owner
  if (apiKey.userId !== workflowUserId) {
    return {
      valid: false,
      error: "You do not have permission to run this workflow",
      statusCode: 403,
    };
  }

  // Update last used timestamp (don't await, fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {
      // Fire and forget - ignore errors
    });

  return { valid: true };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function executeWorkflowBackground(
  executionId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  input: Record<string, unknown>,
  organizationId?: string | null,
  ownerId?: string,
  organizationSlug?: string
) {
  try {
    console.log("[Webhook] Starting execution:", executionId);

    console.log("[Webhook] Calling executeWorkflow with:", {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hasExecutionId: !!executionId,
      workflowId,
    });

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
      },
    ]);

    console.log("[Webhook] Workflow started, runId:", run.runId);

    await db
      .update(workflowExecutions)
      .set({ runId: run.runId })
      .where(eq(workflowExecutions.id, executionId));
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Error during execution", error, { endpoint: "/api/workflows/[workflowId]/webhook", operation: "executeWorkflow" });

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

export function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const timer = createTimer();

  try {
    const { workflowId } = await context.params;

    // Get workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 404,
        error: "Workflow not found",
      });
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Validate API key - must belong to the workflow owner
    const authHeader = request.headers.get("Authorization");
    const apiKeyValidation = await validateApiKey(authHeader, workflow.userId);

    if (!apiKeyValidation.valid) {
      const statusCode = apiKeyValidation.statusCode || 401;
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode,
        error: apiKeyValidation.error,
      });
      return NextResponse.json(
        { error: apiKeyValidation.error },
        { status: statusCode, headers: corsHeaders }
      );
    }

    // Verify this is a webhook-triggered workflow
    const triggerNode = (workflow.nodes as WorkflowNode[]).find(
      (node) => node.data.type === "trigger"
    );

    if (!triggerNode || triggerNode.data.config?.triggerType !== "Webhook") {
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 400,
        error: "This workflow is not configured for webhook triggers",
      });
      return NextResponse.json(
        { error: "This workflow is not configured for webhook triggers" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate that all integrationIds in workflow nodes belong to the workflow owner
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      workflow.userId,
      workflow.organizationId
    );
    if (!validation.valid) {
      logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Invalid integration references", new Error(String(validation.invalidIds)), { endpoint: "/api/workflows/[workflowId]/webhook", operation: "validateIntegrations" });
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 403,
        error: "Workflow contains invalid integration references",
      });
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403, headers: corsHeaders }
      );
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: EXECUTION_LIMIT_ERROR,
      });
      const body = await executionGuard.response.json();
      return NextResponse.json(body, {
        status: 429,
        headers: corsHeaders,
      });
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: "Too many concurrent workflow executions",
      });
      return NextResponse.json(
        {
          error: "Too many concurrent workflow executions",
          running: concurrencyCheck.running,
          limit: concurrencyCheck.limit,
        },
        { status: 429, headers: { ...corsHeaders, "Retry-After": "30" } }
      );
    }

    // Parse request body
    const body = await request.json().catch(() => ({}));

    // Create execution record
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: workflow.userId,
        status: "running",
        input: body,
      })
      .returning();

    console.log("[Webhook] Created execution:", execution.id);

    // Record workflow execution metric in API process (workflow runs in separate context)
    const metrics = getMetricsCollector();
    metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_TOTAL, {
      [LabelKeys.TRIGGER_TYPE]: "webhook",
      [LabelKeys.WORKFLOW_ID]: workflowId,
    });

    // Resolve org slug for log labels (cached per request)
    const organizationSlug = await getOrgSlug(workflow.organizationId);

    // Execute the workflow in the background (don't await)
    executeWorkflowBackground(
      execution.id,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      body,
      workflow.organizationId,
      workflow.userId,
      organizationSlug
    );

    recordWebhookMetrics({
      workflowId,
      executionId: execution.id,
      durationMs: timer(),
      statusCode: 200,
    });

    // Return immediately with the execution ID
    return NextResponse.json(
      {
        executionId: execution.id,
        status: "running",
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Failed to start workflow execution", error, { endpoint: "/api/workflows/[workflowId]/webhook", operation: "post" });

    const { workflowId } = await context.params;
    recordWebhookMetrics({
      workflowId,
      durationMs: timer(),
      statusCode: 500,
      error:
        error instanceof Error ? error.message : "Failed to execute workflow",
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
