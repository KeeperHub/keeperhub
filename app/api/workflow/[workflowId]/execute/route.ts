import { HttpStatus } from "@/lib/http-status";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logAnonymousExecutionBlock } from "@/lib/auth-anonymous-guard";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { getMetricsCollector } from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { requireScope } from "@/lib/middleware/require-scope";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { db } from "@/lib/db";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import {
  buildAttribution,
  type ExecutionCredentialType,
  resolveTriggerLabels,
} from "@/lib/security/request-attribution";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { resolveExecutionOrgMetadata } from "@/lib/db/org-helpers";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { getWorkflowAccess } from "@/lib/workflow/access";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { executeWorkflowInBackground } from "@/lib/workflow/execute-in-background";
import { loadWorkflowForExecution } from "@/lib/workflow/load-for-execution";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Workflow execution requires complex error handling and validation
export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Capture the raw body once. The internal-service HMAC verifier binds it
    // into the signature, and the body parse at line 175 below needs to read
    // from the same bytes -- request.body is a single-use stream so a later
    // request.json() would throw "body already used".
    const rawBody = await request.text();

    // Check for internal service authentication (MCP, Events, Scheduler)
    const internalAuth = await authenticateInternalService(request, rawBody);
    const isInternalExecution = internalAuth.authenticated;

    let userId: string;
    let orgApiKeyId: string | null = null;
    let credentialType: ExecutionCredentialType | null = null;
    let credentialLabel: string | null = null;

    // Load workflow + evaluate lifecycle in one round-trip. requireEnabled maps
    // to the dispatch context: internal callers (scheduler/executor routing back
    // through this route) must not run a disabled workflow, but interactive
    // callers (the editor "Run" button) may test a not-yet-enabled workflow.
    const loaded = await loadWorkflowForExecution(workflowId, {
      requireEnabled: isInternalExecution,
    });
    if (loaded.status === "not_found" || loaded.status === "not_executable") {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: HttpStatus.NOT_FOUND }
      );
    }
    const { workflow } = loaded;

    if (isInternalExecution) {
      // Internal execution from authenticated service
      console.log(
        `[Workflow Execute] Internal execution from service: ${internalAuth.caller}`
      );

      credentialType = "internal";
      credentialLabel = internalAuth.caller ?? null;

      // Internal service auth already verified by authenticateInternalService.
      // Org membership check would require organizationId but internal callers
      // have no session org — and all workflows are NOT NULL on organizationId
      // post-migration, so passing null here would always 404. Lifecycle checks
      // (deleted, deactivated) are handled by loadWorkflowForExecution above.
      userId = workflow.userId;
    } else {
      const authContext = await getDualAuthContext(request);
      if ("error" in authContext) {
        return NextResponse.json(
          { error: authContext.error },
          { status: authContext.status }
        );
      }

      // Anonymous principals may browse and build but never run. Token and
      // api-key callers are already refused at auth resolution; this closes
      // the browser-session path.
      if (authContext.isAnonymous) {
        logAnonymousExecutionBlock("workflow_execute", authContext.userId, {
          workflowId,
        });
        return NextResponse.json(
          { error: "Sign up to run workflows" },
          { status: HttpStatus.FORBIDDEN }
        );
      }

      const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE);
      if (scopeError) {
        return scopeError;
      }

      const access = await getWorkflowAccess(workflow, {
        userId: authContext.userId,
        organizationId: authContext.organizationId,
        authMethod: authContext.authMethod,
      });

      if (!access.hasFullAccess) {
        return NextResponse.json(
          { error: "Workflow not found" },
          { status: HttpStatus.NOT_FOUND }
        );
      }

      userId = authContext.userId ?? workflow.userId;
      if (authContext.authMethod === "api-key") {
        orgApiKeyId = authContext.apiKeyId;
        credentialType = "org_api_key";
        // The org key row is soft-revoked (never hard-deleted), so its prefix
        // stays joinable via triggered_by_org_api_key_id; no label lookup on
        // this hot path.
      } else if (authContext.authMethod === "oauth") {
        credentialType = "oauth";
      } else {
        credentialType = "session";
      }
    }

    // Validate integration references as the ORG principal: the org owns the
    // workflow, so a run uses the org's integrations regardless of who
    // triggered it, matching the runtime credential fetch.
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      workflow.organizationId
    );
    if (!validation.valid) {
      logSystemError(ErrorCategory.WORKFLOW_ENGINE, "[Workflow Execute] Invalid integration references", new Error(String(validation.invalidIds)), { endpoint: "/api/workflow/[workflowId]/execute", operation: "validateIntegrations" });
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: HttpStatus.FORBIDDEN }
      );
    }

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(workflow.nodes as unknown[]),
      workflow.organizationId
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      return executionGuard.response;
    }

    const concurrencyCheck = await checkConcurrencyLimit();
    if (!concurrencyCheck.allowed) {
      const retryAfter = 30;
      return applyRateLimitHeaders(
        NextResponse.json(
          {
            error: "Too many concurrent workflow executions",
            running: concurrencyCheck.running,
            limit: concurrencyCheck.limit,
          },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        {
          limit: concurrencyCheck.limit,
          remaining: 0,
          reset: Math.ceil(Date.now() / 1000) + retryAfter,
          retryAfter,
        }
      );
    }

    // Parse request body from the captured raw bytes. Preserves the original
    // "missing or invalid body becomes empty input" contract.
    type ExecuteBody = { input?: unknown; executionId?: string };
    let body: ExecuteBody = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as ExecuteBody;
      } catch {
        body = {};
      }
    }
    const input = (body.input as Record<string, unknown> | undefined) ?? {};

    // Idempotency: a retry with the same key + body replays the original
    // executionId instead of starting the workflow again. Scoped per workflow.
    const idem = await beginIdempotentFromRequest({
      request,
      organizationId: workflow.organizationId,
      scope: `workflow-execute:${workflowId}`,
      requestBody: body,
    });
    if (idem) {
      const early = idempotencyEarlyResponse(idem);
      if (early) {
        return NextResponse.json(early.body, { status: early.status });
      }
    }

    // Resolve the (metric, audit) trigger labels in one place -- see
    // resolveTriggerLabels for the schedule/scheduled convergence and the
    // intentional triggerType-vs-triggerSource divergence. Extracted +
    // unit-tested so a value typo can't silently re-fragment the metric.
    const { triggerType, triggerSource } = resolveTriggerLabels(
      request.headers.get("x-trigger-type"),
      isInternalExecution
    );
    const attribution = buildAttribution({
      request,
      source: triggerSource,
      orgApiKeyId,
      credentialType,
      credentialLabel,
    });
    const executedWorkflowHash = hashWorkflowDefinition(
      workflow.nodes,
      workflow.edges
    );

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
        await withBackstopCapture(
          { workflowId, userId, source: triggerSource },
          () =>
            db.insert(workflowExecutions).values({
              id: executionId,
              workflowId,
              userId,
              status: "pending",
              input,
              ...attribution,
              executedWorkflowHash,
            })
        );
        console.log("[API] Created execution with provided ID:", executionId);
        createdHere = true;
      }
    } else {
      // Create new execution record
      const [execution] = await withBackstopCapture(
        { workflowId, userId, source: triggerSource },
        () =>
          db
            .insert(workflowExecutions)
            .values({
              workflowId,
              userId,
              status: "pending",
              input,
              ...attribution,
              executedWorkflowHash,
            })
            .returning()
      );

      executionId = execution.id;
      console.log("[API] Created execution:", executionId);
      createdHere = true;
    }

    // Record per-trigger_type start of a workflow execution. Drives the
    // Grafana "zero executions in N min" alert family (see KEEP-556). Skipped
    // when the executor pre-created the row - it already incremented on its
    // side in that case.
    if (createdHere) {
      const metrics = getMetricsCollector();
      metrics.incrementCounter(MetricNames.WORKFLOW_EXECUTIONS_STARTED_TOTAL, {
        [LabelKeys.TRIGGER_TYPE]: triggerType,
      });
    }

    // PAYG: a free-tier org past its included limit is admitted by
    // enforceExecutionLimit only so it can be charged here. Settle the
    // per-execution price before the run starts, the same charge the queue
    // executor and direct-execute API apply, so every execution path bills
    // once. On a funds, cap, or payment block, resolve the row to a billing
    // error and stop; the run must not proceed unpaid. Non-PAYG orgs and
    // in-bucket runs return applicable:false and pass through untouched.
    const paygCharge = await chargePaygIfBillable({
      organizationId: workflow.organizationId,
      executionId,
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
        .where(eq(workflowExecutions.id, executionId));
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: paygCharge.message, executionId, status: "error" },
          { status: HttpStatus.PAYMENT_REQUIRED }
        ),
        "failed"
      );
    }

    // Resolve org slug + plan for log labels (cached per request)
    const {
      slug: organizationSlug,
      plan: organizationPlan,
    } = await resolveExecutionOrgMetadata(workflow.organizationId);

    // Execute the workflow in the background (don't await)
    executeWorkflowInBackground(
      executionId,
      workflowId,
      workflow.nodes as WorkflowNode[],
      workflow.edges as WorkflowEdge[],
      input,
      {
        logPrefix: "[Workflow Execute]",
        endpoint: "/api/workflow/[workflowId]/execute",
      },
      workflow.organizationId,
      workflow.userId,
      organizationSlug,
      organizationPlan
    );

    // Return immediately with the execution ID
    return recordIdempotentResponse(
      idem,
      NextResponse.json({
        executionId,
        status: "running",
      })
    );
  } catch (error) {
    logSystemError(ErrorCategory.WORKFLOW_ENGINE, "Failed to start workflow execution", error, { endpoint: "/api/workflow/[workflowId]/execute", operation: "post" });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start workflow execution",
      },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
