import { HttpStatus } from "@/lib/http-status";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  createTimer,
  getMetricsCollector,
} from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import {
  EXECUTION_LIMIT_ERROR,
  enforceExecutionLimit,
} from "@/lib/billing/execution-guard";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { recordWebhookMetrics } from "@/lib/metrics/instrumentation/api";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { extractActionTypeNodes } from "@/lib/features";
import {
  enforceWorkflowFeatures,
  FEATURE_UPGRADE_REQUIRED_ERROR,
} from "@/lib/features/route-guard";
import {
  apiKeys,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { resolveExecutionOrgMetadata } from "@/lib/db/org-helpers";
import { webhookPayloadSchema } from "@/lib/schemas/webhook";
import { validateData } from "@/lib/validate-request";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import { buildAttribution } from "@/lib/security/request-attribution";
import {
  getWorkflowAccess,
  isUserMemberOfOrganization,
} from "@/lib/workflow/access";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { executeWorkflowInBackground } from "@/lib/workflow/execute-in-background";
import { loadWorkflowForExecution } from "@/lib/workflow/load-for-execution";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
type ValidateApiKeyResult = {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  keyPrefix?: string;
  error?: string;
  statusCode?: number;
  errorBody?: Record<string, unknown>;
};

// Validate API key and return the user ID if valid. The org owns the
// workflow, so the key must belong to a CURRENT MEMBER of the workflow's
// org - not specifically its creator.
async function validateApiKey(
  authHeader: string | null,
  workflowOrganizationId: string
): Promise<ValidateApiKeyResult> {
  if (!authHeader) {
    return {
      valid: false,
      error: "Missing Authorization header",
      statusCode: HttpStatus.UNAUTHORIZED,
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
        statusCode: HttpStatus.UNAUTHORIZED,
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
      statusCode: HttpStatus.UNAUTHORIZED,
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
    return { valid: false, error: "Invalid API key", statusCode: HttpStatus.UNAUTHORIZED };
  }

  // Verify the key's holder is a current member of the workflow's org.
  // (A deactivated member cannot reach here: the deactivation cascade
  // deletes their api_keys rows.)
  const isMember = await isUserMemberOfOrganization(
    apiKey.userId,
    workflowOrganizationId
  );
  if (!isMember) {
    return {
      valid: false,
      error: "You do not have permission to run this workflow",
      statusCode: HttpStatus.FORBIDDEN,
    };
  }

  // Update last used timestamp (don't await, fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {
      // Fire and forget - ignore errors
    });

  return {
    valid: true,
    userId: apiKey.userId,
    apiKeyId: apiKey.id,
    keyPrefix: apiKey.keyPrefix,
  };
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

    // Load workflow + evaluate lifecycle before API-key validation so a
    // non-executable workflow never triggers an auth round-trip.
    const loaded = await loadWorkflowForExecution(workflowId, {
      requireEnabled: true,
    });
    if (loaded.status === "not_found") {
      return failResponse(workflowId, timer, HttpStatus.NOT_FOUND, "Workflow not found");
    }
    if (loaded.status === "not_executable") {
      if (loaded.reason === "disabled") {
        return failResponse(workflowId, timer, HttpStatus.GONE, "Workflow is disabled");
      }
      return failResponse(workflowId, timer, HttpStatus.NOT_FOUND, "Workflow not found");
    }
    const { workflow } = loaded;

    // Validate API key - must belong to the workflow owner
    const authHeader = request.headers.get("Authorization");
    const apiKeyValidation = await validateApiKey(
      authHeader,
      workflow.organizationId
    );

    if (!apiKeyValidation.valid) {
      return failResponse(
        workflowId,
        timer,
        apiKeyValidation.statusCode ?? HttpStatus.UNAUTHORIZED,
        apiKeyValidation.error ?? "Invalid API key",
        apiKeyValidation.errorBody
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId: apiKeyValidation.userId ?? null,
      organizationId: workflow.organizationId,
      authMethod: "webhook",
    });

    if (!access.hasFullAccess) {
      return failResponse(workflowId, timer, HttpStatus.NOT_FOUND, "Workflow not found");
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

    // Validate integration references as the ORG principal (the org owns the
    // workflow), matching the runtime credential fetch.
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
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

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(workflow.nodes as unknown[]),
      workflow.organizationId
    );
    if (featureGuard.blocked) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: FEATURE_UPGRADE_REQUIRED_ERROR,
        organizationId: workflow.organizationId,
      });
      const body = await featureGuard.response.json();
      return NextResponse.json(body, {
        status: HttpStatus.PAYMENT_REQUIRED,
        headers: corsHeaders,
      });
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: EXECUTION_LIMIT_ERROR,
        organizationId: workflow.organizationId,
      });
      const body = (await executionGuard.response.json()) as {
        limit?: number;
      };
      // Monthly billing quota with no clean sliding-window reset, so advertise a
      // fixed Retry-After matching the concurrency block plus the guard's limit.
      const retryAfter = 30;
      return applyRateLimitHeaders(
        NextResponse.json(body, {
          status: HttpStatus.TOO_MANY_REQUESTS,
          headers: corsHeaders,
        }),
        {
          limit: typeof body.limit === "number" ? body.limit : 0,
          remaining: 0,
          reset: Math.ceil(Date.now() / 1000) + retryAfter,
          retryAfter,
        }
      );
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      await recordWebhookMetrics({
        workflowId,
        durationMs: timer(),
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: "Too many concurrent workflow executions",
        organizationId: workflow.organizationId,
      });
      const retryAfter = 30;
      return applyRateLimitHeaders(
        NextResponse.json(
          {
            error: "Too many concurrent workflow executions",
            running: concurrencyCheck.running,
            limit: concurrencyCheck.limit,
          },
          { status: HttpStatus.TOO_MANY_REQUESTS, headers: corsHeaders }
        ),
        {
          limit: concurrencyCheck.limit,
          remaining: 0,
          reset: Math.ceil(Date.now() / 1000) + retryAfter,
          retryAfter,
        }
      );
    }

    // Parse + validate the webhook payload (KEEP-828). Contents are freeform
    // (forwarded to the workflow as trigger input), but the envelope must be a
    // JSON object so template references resolve. An empty body is allowed and
    // triggers the workflow with no input.
    let body: Record<string, unknown> = {};
    const rawBody = await request.text();
    if (rawBody.trim() !== "") {
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(rawBody);
      } catch {
        return failResponse(workflowId, timer, 400, "Invalid JSON body");
      }
      const payloadValidation = validateData(parsedPayload, webhookPayloadSchema);
      if (!payloadValidation.success) {
        return failResponse(
          workflowId,
          timer,
          400,
          "Webhook payload must be a JSON object"
        );
      }
      body = payloadValidation.data;
    }

    // Idempotency: a retry carrying the same key + body replays the original
    // executionId instead of triggering the workflow again. Scoped per workflow.
    const idem = await beginIdempotentFromRequest({
      request,
      organizationId: workflow.organizationId,
      scope: `webhook:${workflowId}`,
      requestBody: body,
    });
    if (idem) {
      const early = idempotencyEarlyResponse(idem);
      if (early) {
        return NextResponse.json(early.body, {
          status: early.status,
          headers: corsHeaders,
        });
      }
    }

    const attribution = buildAttribution({
      request,
      source: "webhook",
      userApiKeyId: apiKeyValidation.apiKeyId ?? null,
      credentialType: "webhook_key",
      credentialLabel: apiKeyValidation.keyPrefix ?? null,
    });

    // Create execution record
    const [execution] = await withBackstopCapture(
      { workflowId, userId: workflow.userId, source: "webhook" },
      () =>
        db
          .insert(workflowExecutions)
          .values({
            workflowId,
            userId: workflow.userId,
            status: "pending",
            input: body,
            ...attribution,
            executedWorkflowHash: hashWorkflowDefinition(
              workflow.nodes,
              workflow.edges
            ),
          })
          .returning()
    );

    console.log("[Webhook] Created execution:", execution.id);

    // Record per-trigger_type start of a workflow execution. See KEEP-556.
    const metrics = getMetricsCollector();
    metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL, {
      [LabelKeys.TRIGGER_TYPE]: "webhook",
    });

    // PAYG: enforceExecutionLimit admits a free-tier org past its limit only so
    // it can be charged here. Settle the per-execution price before the run
    // starts so webhook-triggered runs bill exactly like every other path. On a
    // funds, cap, or payment block, resolve the row to a billing error and stop.
    const paygCharge = await chargePaygIfBillable({
      organizationId: workflow.organizationId,
      executionId: execution.id,
    });
    if (paygCharge.applicable && !paygCharge.ok) {
      await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error: paygCharge.message,
          errorCategory: "billing",
          errorType: "user",
          // Unpaid means the run never started, so it consumes no quota.
          billable: false,
          completedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, execution.id));
      await recordWebhookMetrics({
        workflowId,
        executionId: execution.id,
        durationMs: timer(),
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: paygCharge.message,
        organizationId: workflow.organizationId,
      });
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          {
            error: paygCharge.message,
            executionId: execution.id,
            status: "error",
          },
          { status: HttpStatus.PAYMENT_REQUIRED, headers: corsHeaders }
        ),
        "failed"
      );
    }

    // Resolve org slug + plan for log labels (cached per request)
    const { slug: organizationSlug, plan: organizationPlan } =
      await resolveExecutionOrgMetadata(workflow.organizationId);

    // Execute the workflow in the background (don't await)
    executeWorkflowInBackground(
      execution.id,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      body,
      {
        logPrefix: "[Webhook]",
        endpoint: "/api/workflows/[workflowId]/webhook",
      },
      workflow.organizationId,
      workflow.userId,
      organizationSlug,
      organizationPlan,
      "webhook"
    );

    await recordWebhookMetrics({
      workflowId,
      executionId: execution.id,
      durationMs: timer(),
      statusCode: HttpStatus.OK,
    });

    // Return immediately with the execution ID
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          executionId: execution.id,
          status: "running",
        },
        { headers: corsHeaders }
      )
    );
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Webhook] Failed to start workflow execution", error, { endpoint: "/api/workflows/[workflowId]/webhook", operation: "post" });

    const { workflowId } = await context.params;
    const message =
      error instanceof Error ? error.message : "Failed to execute workflow";
    return failResponse(workflowId, timer, HttpStatus.INTERNAL_SERVER_ERROR, message);
  }
}
