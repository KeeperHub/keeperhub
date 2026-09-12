import { HttpStatus } from "@/lib/http-status";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logAnonymousExecutionBlock } from "@/lib/auth-anonymous-guard";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  ErrorCategory,
  logSecurityEvent,
  logSystemError,
  logUserError,
} from "@/lib/logging";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { getMetricsCollector } from "@/lib/metrics";
import { LabelKeys, MetricNames } from "@/lib/metrics/types";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { requireScope } from "@/lib/middleware/require-scope";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { db } from "@/lib/db";
import { pythDispatchRefusal } from "@/lib/pyth/validate-dispatch";
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
import {
  resolveExecutionInput,
  topLevelInputDeprecationHeaders,
} from "@/lib/workflow/resolve-execution-input";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

/**
 * Set the bare-shape deprecation headers on a response.
 *
 * The single place they are written. `withDeprecation` inside the handler
 * gates this on the body actually having used the deprecated shape; the
 * mixed-shape 400 calls it directly, because a rejected body carries no flag
 * to gate on and that caller needs the migration link most of all.
 */
function applyDeprecationHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of topLevelInputDeprecationHeaders()) {
    response.headers.set(name, value);
  }
  return response;
}

/** The `workflow_executions` columns the pre-created-id path reads. */
type ExistingExecutionRow = {
  workflowId: string;
  organizationId: string | null;
  status: string;
};

/**
 * Adopt the row (`adopt: true`, caller continues on it) or answer for it.
 */
type ExistingExecutionOutcome =
  | { adopt: true }
  | {
      adopt: false;
      response: NextResponse;
      disposition: "success" | "release";
    };

/**
 * The answer for a pre-created executionId that already names a row: refuse a
 * foreign row, refuse a terminal one, ack a running one, adopt a pending one.
 *
 * Both sides of the pre-create race resolve through here -- the lookup before
 * the insert, and the re-read after the insert loses on the primary key. A
 * re-dispatch that arrives a millisecond after the winner commits and one that
 * arrives mid-insert are the same request, and answering them differently
 * would make a legitimate retry succeed or fail on timing alone.
 */
function existingExecutionOutcome(
  existing: ExistingExecutionRow,
  params: { workflowId: string; organizationId: string; executionId: string }
): ExistingExecutionOutcome {
  // organizationId is null on rows written before the column existed, so it is
  // compared only when set; workflowId carries the tenancy. Adopting a foreign
  // row would write this run's status, logs and output over it.
  if (
    existing.workflowId !== params.workflowId ||
    (existing.organizationId !== null &&
      existing.organizationId !== params.organizationId)
  ) {
    logSecurityEvent("execution_id_workflow_mismatch", {
      workflowId: params.workflowId,
      organizationId: params.organizationId,
      rowWorkflowId: existing.workflowId,
    });
    return {
      adopt: false,
      disposition: "release",
      response: NextResponse.json(
        {
          error: "executionId does not belong to this workflow",
          code: "execution_id_mismatch",
        },
        { status: HttpStatus.CONFLICT }
      ),
    };
  }

  if (
    existing.status === "success" ||
    existing.status === "error" ||
    existing.status === "cancelled"
  ) {
    return {
      adopt: false,
      disposition: "release",
      response: NextResponse.json(
        {
          error: "Execution already completed",
          code: "execution_already_terminal",
          executionId: params.executionId,
          status: existing.status,
        },
        { status: HttpStatus.CONFLICT }
      ),
    };
  }

  if (existing.status === "running") {
    return {
      adopt: false,
      disposition: "success",
      response: NextResponse.json({
        executionId: params.executionId,
        status: "running",
      }),
    };
  }

  // pending (scheduler handoff) -- adopt: charge + start once.
  return { adopt: true };
}

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
    if (loaded.status === "not_executable" && loaded.reason === "halted") {
      // Distinct from not-found so an operator recovering from an incident is
      // told the org is halted, not misdirected to a missing-workflow 404.
      return NextResponse.json(
        { error: "Workflow temporarily halted" },
        { status: HttpStatus.SERVICE_UNAVAILABLE }
      );
    }
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

      const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
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

    // Parse request body from the captured raw bytes. See
    // lib/workflow/resolve-execution-input.ts for the resolution
    // rules -- bare top-level fields bind with a deprecation warning, a
    // mixed or malformed body is a 400.
    const resolved = resolveExecutionInput(rawBody);
    if (!resolved.ok) {
      // This 400 carries the notice unconditionally. A body that mixes the two
      // shapes is sent by a caller who is half-migrated already, and this is
      // the response they are most likely to read -- withDeprecation below
      // cannot serve it, since a rejected body has no `deprecated` flag to
      // test.
      return applyDeprecationHeaders(
        NextResponse.json(
          { error: resolved.error, field: resolved.field },
          { status: HttpStatus.BAD_REQUEST }
        )
      );
    }
    const { input } = resolved;

    // The bare top-level shape is deprecated, and the notice has to ride every
    // response this handler returns from here on -- replays included. A caller
    // retrying with an Idempotency-Key would otherwise see it once and never
    // again, which is the opposite of what a migration window needs.
    const withDeprecation = (response: NextResponse): NextResponse =>
      resolved.deprecated ? applyDeprecationHeaders(response) : response;

    if (
      isInternalExecution &&
      request.headers.get("x-trigger-type") === "upstream"
    ) {
      const refusal = pythDispatchRefusal(workflow.nodes, input);
      if (refusal) {
        return withDeprecation(
          NextResponse.json({ error: refusal }, { status: 409 })
        );
      }
    }

    // Idempotency: a retry with the same key + body replays the original
    // executionId instead of starting the workflow again. Scoped per workflow.
    const idem = await beginIdempotentFromRequest({
      request,
      organizationId: workflow.organizationId,
      scope: `workflow-execute:${workflowId}`,
      requestBody: resolved.rawParsed,
    });
    if (idem) {
      const early = idempotencyEarlyResponse(idem);
      if (early) {
        return withDeprecation(
          NextResponse.json(early.body, { status: early.status })
        );
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
    // This allows the executor to pre-create the execution record.
    // Sourced from the resolver rather than the raw body: in the bare
    // top-level shape a key named executionId is caller input, not an
    // envelope field, and must not address an execution row.
    let executionId = resolved.executionId;
    // Whether this request created the workflow_executions row itself, vs.
    // reusing one that the executor pre-created. The KEEP-556 counter only
    // increments here when we created the row, so the executor-side increment
    // and this one never double-count.
    let createdHere = false;

    // The field exists so the scheduler and queue executor can pre-create the
    // row and hand its id back. Nothing else has a reason to name a row that
    // this request did not create, and the workflow access check above
    // authorises the workflow, not the row, so a caller-supplied id from any
    // other principal is refused outright.
    //
    // Gated on the key being present, not on it having parsed to a usable id.
    // `{"executionId": 12345}` from an external caller is the same probe as
    // the string form, and answering it 200 would drop the security signal on
    // the shape most likely to be a probe. An internal caller sending a
    // non-string gets a fresh row instead of the id it named -- no shipped
    // dispatcher does that, and it is preferable to feeding a non-string to a
    // primary-key lookup.
    if (resolved.executionIdPresent && !isInternalExecution) {
      logSecurityEvent("execution_id_supplied_by_external_caller", {
        workflowId,
        organizationId: workflow.organizationId,
        userId,
      });
      return recordIdempotentResponse(
        idem,
        withDeprecation(
          NextResponse.json(
            {
              error: "executionId is reserved for internal dispatch",
              code: "execution_id_not_allowed",
            },
            { status: HttpStatus.BAD_REQUEST }
          )
        ),
        "release"
      );
    }

    if (executionId) {
      const outcomeParams = {
        workflowId,
        organizationId: workflow.organizationId,
        executionId,
      };

      // Scheduler may pre-create a pending row and hand the id back here.
      // Refuse terminal / in-flight reuse before PAYG so a retry cannot
      // charge again or start a second DevKit run. The lookup is by primary
      // key alone, so the row it returns is not necessarily this workflow's --
      // existingExecutionOutcome is what refuses a foreign one.
      const existingExecution = await db.query.workflowExecutions.findFirst({
        where: eq(workflowExecutions.id, executionId),
      });
      const existing = existingExecution
        ? existingExecutionOutcome(existingExecution, outcomeParams)
        : null;

      if (existing && !existing.adopt) {
        return recordIdempotentResponse(
          idem,
          withDeprecation(existing.response),
          existing.disposition
        );
      }

      if (existing) {
        console.log("[API] Using existing execution:", executionId);
      } else {
        // A miss on the lookup means the id was free when we read it, not
        // that it still is: two dispatches naming the same id can both reach
        // here and only one insert wins. withBackstopCapture special-cases
        // only 42501, so the loser's primary-key violation would reach the
        // outer catch and answer 500 with the driver's constraint text in it.
        try {
          await withBackstopCapture(
            { workflowId, userId, source: triggerSource },
            () =>
              db.insert(workflowExecutions).values({
                id: executionId,
                workflowId,
                organizationId: workflow.organizationId,
                userId,
                status: "pending",
                input,
                ...attribution,
                executedWorkflowHash,
              })
          );
          console.log("[API] Created execution with provided ID:", executionId);
          createdHere = true;
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          // Losing the race is the lookup above arriving one instant early:
          // the winner committed the row between the read and the insert. So
          // re-read it and take the same branch the lookup would have taken,
          // rather than answering a 409 the earlier arrival would not have
          // got. The dispatcher cannot re-issue under a different id -- the
          // executionId is pre-created and fixed -- and executeViaApi throws
          // on any non-2xx, so a 409 here turns a legitimate re-dispatch into
          // a hard executor failure decided by scheduling jitter.
          const winner = await db.query.workflowExecutions.findFirst({
            where: eq(workflowExecutions.id, executionId),
          });
          if (!winner) {
            // The insert says the id was taken and the re-read says no row
            // holds it: the winner rolled back in between. There is nothing
            // to adopt, and retrying the dispatch under the same id will now
            // find it free.
            logUserError(
              ErrorCategory.VALIDATION,
              "[Execute] executionId claimed by a dispatch that rolled back",
              undefined,
              { workflowId, endpoint: "/api/workflow/[workflowId]/execute" }
            );
            return recordIdempotentResponse(
              idem,
              withDeprecation(
                NextResponse.json(
                  {
                    error:
                      "The provided executionId was claimed by a concurrent dispatch that did not complete. Retry the dispatch with the same id.",
                    code: "execution_id_conflict",
                    executionId,
                  },
                  { status: HttpStatus.CONFLICT }
                )
              ),
              "release"
            );
          }
          const raced = existingExecutionOutcome(winner, outcomeParams);
          if (!raced.adopt) {
            return recordIdempotentResponse(
              idem,
              withDeprecation(raced.response),
              raced.disposition
            );
          }
          console.log(
            "[API] Adopting execution created by a concurrent dispatch:",
            executionId
          );
        }
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
              organizationId: workflow.organizationId,
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
      paygOverflow: executionGuard.limitResult?.paygOverflow === true,
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
        withDeprecation(
          NextResponse.json(
            { error: paygCharge.message, executionId, status: "error" },
            { status: HttpStatus.PAYMENT_REQUIRED }
          )
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
    const successResponse = withDeprecation(
      NextResponse.json({
        executionId,
        status: "running",
      })
    );
    return recordIdempotentResponse(idem, successResponse);
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
