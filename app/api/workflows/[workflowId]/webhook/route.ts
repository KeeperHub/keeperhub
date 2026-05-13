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
import { getOrgPlanLabel, getOrgSlug } from "@/lib/db/org-helpers";
import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
type ValidateApiKeyResult = {
  valid: boolean;
  error?: string;
  statusCode?: number;
  errorBody?: Record<string, unknown>;
};

// Validate API key and return the user ID if valid
async function validateApiKey(
  authHeader: string | null,
  workflowUserId: string
): Promise<ValidateApiKeyResult> {
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
    // Builders frequently paste their org-scoped kh_* key here because the
    // rest of the API accepts it. Surface the prefix mismatch explicitly so
    // they don't have to discover via Discord that this endpoint expects a
    // user webhook key (KEEP-469).
    if (key?.startsWith("kh_")) {
      return {
        valid: false,
        statusCode: 401,
        error:
          "Wrong API key type. This endpoint requires a user webhook key (wfb_*). The kh_* prefix is an org API key for /api/execute/* and /mcp.",
        errorBody: {
          code: "wrong_key_type",
          expected: "wfb_*",
          received: "kh_*",
          hint: "Generate a webhook key from the user menu > API Keys > Webhook tab, then pass it as `Authorization: Bearer wfb_...`.",
        },
      };
    }
    return {
      valid: false,
      statusCode: 401,
      error:
        "Invalid API key format. Expected a user webhook key starting with wfb_.",
      errorBody: {
        code: "invalid_key_format",
        expected: "wfb_*",
      },
    };
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

/**
 * Build a `{ error: message }` JSON response and emit the matching webhook
 * metric in one call. Covers the simple-error gates (404, 410, 401, 403, 400,
 * 500). The two 429 variants have custom response bodies and stay inline.
 */
async function failResponse(
  workflowId: string,
  timer: () => number,
  statusCode: number,
  message: string,
  extraBody?: Record<string, unknown>
): Promise<NextResponse> {
  await recordWebhookMetrics({
    workflowId,
    durationMs: timer(),
    statusCode,
    error: message,
  });
  return NextResponse.json(
    { error: message, ...extraBody },
    { status: statusCode, headers: corsHeaders }
  );
}

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
        organizationPlan,
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
      return failResponse(workflowId, timer, 404, "Workflow not found");
    }

    // Aligned with schedule/event/block trigger paths, which all gate on
    // workflows.enabled. Without this check a disabled workflow keeps
    // executing every time the caller hits the URL.
    if (!workflow.enabled) {
      return failResponse(workflowId, timer, 410, "Workflow is disabled");
    }

    // Validate API key - must belong to the workflow owner
    const authHeader = request.headers.get("Authorization");
    const apiKeyValidation = await validateApiKey(authHeader, workflow.userId);

    if (!apiKeyValidation.valid) {
      return failResponse(
        workflowId,
        timer,
        apiKeyValidation.statusCode ?? 401,
        apiKeyValidation.error ?? "Invalid API key",
        apiKeyValidation.errorBody
      );
    }

    // Verify this is a webhook-triggered workflow
    const triggerNode = (workflow.nodes as WorkflowNode[]).find(
      (node) => node.data.type === "trigger"
    );

    if (!triggerNode || triggerNode.data.config?.triggerType !== "Webhook") {
      return failResponse(
        workflowId,
        timer,
        400,
        "This workflow is not configured for webhook triggers"
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
      return failResponse(
        workflowId,
        timer,
        403,
        "Workflow contains invalid integration references"
      );
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: EXECUTION_LIMIT_ERROR,
        organizationId: workflow.organizationId,
      });
      const body = await executionGuard.response.json();
      return NextResponse.json(body, {
        status: 429,
        headers: corsHeaders,
      });
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: 429,
        error: "Too many concurrent workflow executions",
        organizationId: workflow.organizationId,
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

    // Record per-(trigger_type, chain) start of a workflow execution. See KEEP-556.
    const chainLabel = workflow.chain ?? "_unknown";
    const metrics = getMetricsCollector();
    metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL, {
      [LabelKeys.TRIGGER_TYPE]: "webhook",
      [LabelKeys.CHAIN]: chainLabel,
    });

    // Resolve org slug + plan for log labels (cached per request)
    const [organizationSlug, organizationPlan] = await Promise.all([
      getOrgSlug(workflow.organizationId),
      getOrgPlanLabel(workflow.organizationId),
    ]);

    // Execute the workflow in the background (don't await)
    executeWorkflowBackground(
      execution.id,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      body,
      workflow.organizationId,
      workflow.userId,
      organizationSlug,
      organizationPlan
    );

    await recordWebhookMetrics({
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
    const message =
      error instanceof Error ? error.message : "Failed to execute workflow";
    return failResponse(workflowId, timer, 500, message);
  }
}
