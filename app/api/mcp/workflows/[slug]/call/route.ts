import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { checkConcurrencyLimit } from "@/app/api/execute/_lib/concurrency-limit";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { priceQualifiesForMarketplaceExemption } from "@/lib/billing/marketplace-billing";
import { chargePaygIfBillable } from "@/lib/billing/payg/charge";
import { db } from "@/lib/db";
import { resolveExecutionOrgMetadata } from "@/lib/db/org-helpers";
import {
  organization,
  tags,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkIpRateLimit,
  getClientIp,
  type RateLimitResult,
} from "@/lib/mcp/rate-limit";
import { hashMppCredential } from "@/lib/payments/mpp/server";
import {
  detectProtocol,
  gatePayment,
  type PaymentMeta,
} from "@/lib/payments/router";
import { buildCallCompletionResponse } from "@/lib/payments/x402/execution-wait";
import {
  hashPaymentSignature,
  recordPayment,
  resolveCreatorWallet,
} from "@/lib/payments/x402/payment-gate";
import {
  CALL_ROUTE_COLUMNS,
  type CallRouteWorkflow,
} from "@/lib/payments/x402/types";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import { buildAttribution } from "@/lib/security/request-attribution";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { workflowReachableConditions } from "@/lib/workflow/executable";
import { buildExecutorInput } from "@/lib/workflow/executor/build-executor-input";
import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "Payment-Receipt",
} as const;

export function OPTIONS(): NextResponse {
  return NextResponse.json({}, { headers: corsHeaders });
}

/**
 * Validates required fields from a JSON Schema object against the request body.
 * Only checks that required fields are present -- does not strictly validate types
 * or reject extra fields (callers may include metadata).
 */
function validateInputSchema(
  inputSchema: Record<string, unknown>,
  body: Record<string, unknown>
): { valid: true } | { valid: false; error: string } {
  if (!("properties" in inputSchema)) {
    return { valid: true };
  }

  const required = inputSchema.required;
  if (!Array.isArray(required)) {
    return { valid: true };
  }

  for (const field of required) {
    if (typeof field === "string" && !(field in body)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  return { valid: true };
}

/**
 * Runs execution guards, creates a workflow execution record, and starts the
 * workflow in the background. Returns { executionId, status: "running" }
 * immediately (fire-and-forget pattern).
 *
 * Shared by both free and paid call paths to avoid duplicating the
 * guard/insert/start sequence.
 */
/**
 * Runs guards (execution + concurrency) and inserts a workflow_executions row.
 * Returns the new executionId on success, or a NextResponse to short-circuit
 * the request on guard failure. Does NOT start the workflow -- callers do that
 * separately so the paid path can record payment between insert and start.
 */
async function prepareExecution(
  request: Request,
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>
): Promise<{ executionId: string } | { error: NextResponse }> {
  const featureGuard = await enforceWorkflowFeatures(
    extractActionTypeNodes(workflow.nodes as unknown[]),
    workflow.organizationId
  );
  if (featureGuard.blocked) {
    const guardBody = await featureGuard.response.json();
    return {
      error: NextResponse.json(guardBody, {
        status: HttpStatus.PAYMENT_REQUIRED,
        headers: corsHeaders,
      }),
    };
  }

  const executionGuard = await enforceExecutionLimit(workflow.organizationId);
  if (executionGuard.blocked) {
    const guardBody = await executionGuard.response.json();
    return {
      error: NextResponse.json(guardBody, {
        status: HttpStatus.TOO_MANY_REQUESTS,
        headers: corsHeaders,
      }),
    };
  }

  const concurrencyCheck = await checkConcurrencyLimit();
  if (!concurrencyCheck.allowed) {
    return {
      error: NextResponse.json(
        {
          error: "Too many concurrent workflow executions",
          running: concurrencyCheck.running,
          limit: concurrencyCheck.limit,
        },
        {
          status: HttpStatus.TOO_MANY_REQUESTS,
          headers: { ...corsHeaders, "Retry-After": "30" },
        }
      ),
    };
  }

  // Marketplace call path is anonymous (no API key resolves here -- the
  // caller pays via x402 / MPP or hits a free public workflow), so only the
  // source IP and trigger source are recorded.
  const attribution = buildAttribution({ request, source: "mcp" });

  const [execution] = await withBackstopCapture(
    { workflowId: workflow.id, userId: workflow.userId, source: "mcp" },
    () =>
      db
        .insert(workflowExecutions)
        .values({
          workflowId: workflow.id,
          userId: workflow.userId,
          status: "running",
          input: body,
          ...attribution,
          // Tie the run to the definition that executed, so it resolves to a
          // workflow_history version by content hash like every other trigger.
          executedWorkflowHash: hashWorkflowDefinition(
            workflow.nodes,
            workflow.edges
          ),
        })
        .returning()
  );

  // PAYG: a free-tier owner org past its included limit is admitted by
  // enforceExecutionLimit only so it can be charged here. Settle the
  // per-execution price before the run starts, so MCP-triggered runs bill
  // exactly like every other path. On a funds, cap, or payment block, resolve
  // the row to a billing error and stop; non-PAYG orgs pass through untouched.
  // The lookup inner-joins the org, so organizationId is always set here.
  if (workflow.organizationId) {
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
      return {
        error: NextResponse.json(
          {
            error: paygCharge.message,
            executionId: execution.id,
            status: "error",
          },
          { status: HttpStatus.PAYMENT_REQUIRED, headers: corsHeaders }
        ),
      };
    }
  }

  return { executionId: execution.id };
}

/**
 * Fire-and-forget: kicks off the workflow in the background. The HTTP response
 * is returned to the caller immediately while the workflow runs.
 */
async function startExecutionInBackground(
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>,
  executionId: string
): Promise<void> {
  const { slug: organizationSlug, plan: organizationPlan } =
    await resolveExecutionOrgMetadata(workflow.organizationId);
  start(executeWorkflow, [
    buildExecutorInput(workflow, {
      triggerInput: body,
      executionId,
      organizationSlug,
      organizationPlan,
    }),
  ]).catch((err: unknown) => {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[x402/call] Error starting workflow execution",
      err,
      { endpoint: "/api/mcp/workflows/[slug]/call", workflowId: workflow.id }
    );
  });
}

/**
 * Free-path helper: prepares the execution, starts it, and awaits completion
 * up to the read-wait timeout. Returns the mapped output inline on success or
 * falls back to `{executionId, status: "running"}` on timeout.
 */
async function createAndStartExecution(
  request: Request,
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const prepared = await prepareExecution(request, workflow, body);
  if ("error" in prepared) {
    return prepared.error;
  }
  await startExecutionInBackground(workflow, body, prepared.executionId);
  const responseBody = await buildCallCompletionResponse(
    prepared.executionId,
    workflow.outputMapping
  );
  return NextResponse.json(responseBody, { headers: corsHeaders });
}

async function lookupWorkflow(slug: string): Promise<CallRouteWorkflow | null> {
  const rows = await db
    .select({ ...CALL_ROUTE_COLUMNS, tagName: tags.name })
    .from(workflows)
    .leftJoin(tags, eq(workflows.tagId, tags.id))
    .innerJoin(organization, eq(workflows.organizationId, organization.id))
    .where(
      and(
        eq(workflows.listedSlug, slug),
        eq(workflows.isListed, true),
        workflowReachableConditions()
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

function validateBody(
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>
): NextResponse | null {
  if (workflow.inputSchema !== null && "properties" in workflow.inputSchema) {
    const validation = validateInputSchema(workflow.inputSchema, body);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: HttpStatus.BAD_REQUEST, headers: corsHeaders }
      );
    }
  }
  return null;
}

// IP backstop: prevents anonymous junk traffic from reaching DB lookup.
// In-memory per-pod; effective limit is LIMIT * num_replicas.
const CALL_RATE_LIMIT = 30;
const CALL_RATE_WINDOW_MS = 60_000;

function checkCallRateLimit(request: Request): {
  rejected: NextResponse | null;
  rateLimit: RateLimitResult;
} {
  const clientIp = getClientIp(request);
  const rateLimit = checkIpRateLimit(
    clientIp,
    CALL_RATE_LIMIT,
    CALL_RATE_WINDOW_MS
  );
  if (!rateLimit.allowed) {
    return {
      rejected: applyRateLimitHeaders(
        NextResponse.json(
          { error: "Too many requests" },
          { status: HttpStatus.TOO_MANY_REQUESTS, headers: corsHeaders }
        ),
        rateLimit
      ),
      rateLimit,
    };
  }
  return { rejected: null, rateLimit };
}

async function parseJsonBody(
  request: Request
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const parsed = (await request.json()) as Record<string, unknown>;
    return { body: parsed };
  } catch {
    return {
      error: NextResponse.json(
        { error: "Invalid JSON body" },
        { status: HttpStatus.BAD_REQUEST, headers: corsHeaders }
      ),
    };
  }
}

async function handleWriteWorkflow(
  request: Request,
  workflow: CallRouteWorkflow
): Promise<NextResponse> {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return parsed.error;
  }
  const writeBody = parsed.body;
  const writeBodyError = validateBody(workflow, writeBody);
  if (writeBodyError) {
    return writeBodyError;
  }
  const { generateCalldataForWorkflow } = await import("@/lib/mcp/calldata");
  const result = generateCalldataForWorkflow(workflow.nodes, writeBody);
  if (!result.success) {
    return NextResponse.json(
      { error: result.error },
      { status: HttpStatus.BAD_REQUEST, headers: corsHeaders }
    );
  }
  return NextResponse.json(
    {
      type: "calldata",
      to: result.to,
      data: result.data,
      value: result.value,
    },
    { headers: corsHeaders }
  );
}

async function handlePaidWorkflow(
  request: Request,
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const creatorWalletAddress = await resolveCreatorWallet(
    workflow.organizationId
  );
  if (!creatorWalletAddress) {
    return NextResponse.json(
      {
        error: "No payment wallet found for this organization",
        message:
          "The workflow owner must create a wallet in Settings > Wallet before listing paid workflows.",
      },
      { status: HttpStatus.SERVICE_UNAVAILABLE, headers: corsHeaders }
    );
  }

  return gatePayment(
    request,
    workflow,
    creatorWalletAddress,
    (meta: PaymentMeta) => {
      return async (_req: NextRequest): Promise<NextResponse> => {
        const prepared = await prepareExecution(request, workflow, body);
        if ("error" in prepared) {
          return prepared.error;
        }
        const { executionId } = prepared;

        let paymentHash: string;
        if (meta.protocol === "x402") {
          const sig = request.headers.get("PAYMENT-SIGNATURE");
          paymentHash = sig ? hashPaymentSignature(sig) : executionId;
        } else {
          const auth = request.headers.get("authorization");
          paymentHash = auth
            ? hashMppCredential(auth.slice("Payment ".length))
            : executionId;
        }

        // recordPayment + the KEEP-449 billable flip run in one transaction
        // so the workflow_payments row and the workflow_executions.billable
        // bit can never disagree. If the flip fails after recordPayment
        // succeeds, the whole transaction rolls back and the caller sees an
        // error -- preferable to silently over-billing the owner one quota
        // credit and leaving an exempt payment row dangling.
        //
        // Marketplace-paid calls at or above FREE_MARKETPLACE_BILLING_THRESHOLD_USDC
        // are exempt from the owner's monthly execution quota. The flip is
        // tied to actual payment receipt, so owner-initiated runs, scheduled
        // runs, block/event triggers etc. never reach this branch and stay
        // billable=TRUE (the column default).
        try {
          await db.transaction(async (tx) => {
            await recordPayment(
              {
                workflowId: workflow.id,
                paymentHash,
                executionId,
                amountUsdc: workflow.priceUsdcPerCall ?? "0",
                payerAddress: meta.payerAddress,
                creatorWalletAddress,
                protocol: meta.protocol,
                chain: meta.chain,
              },
              tx
            );

            if (
              priceQualifiesForMarketplaceExemption(workflow.priceUsdcPerCall)
            ) {
              await tx
                .update(workflowExecutions)
                .set({ billable: false })
                .where(eq(workflowExecutions.id, executionId));
            }
          });
        } catch (err) {
          // KEEP-545: classify and record per-execution counter increment.
          const errorMessage =
            err instanceof Error
              ? `recordPayment failed: ${err.message}`
              : "recordPayment failed";
          const classification = classifyExecutionError(errorMessage);

          const updated = await db
            .update(workflowExecutions)
            .set({
              status: "error",
              error: errorMessage,
              errorCategory: classification.errorCategory,
              errorType: classification.errorType,
              errorCode: classification.code,
            })
            .where(eq(workflowExecutions.id, executionId))
            .returning({ workflowId: workflowExecutions.workflowId });

          if (updated.length > 0) {
            await recordExecutionErrorFinalized({
              workflowId: updated[0].workflowId,
              errorMessage,
              persistedStatus: "error",
            });
          }
          throw err;
        }

        await startExecutionInBackground(workflow, body, executionId);

        const responseBody = await buildCallCompletionResponse(
          executionId,
          workflow.outputMapping
        );
        return NextResponse.json(responseBody, { headers: corsHeaders });
      };
    }
  );
}

async function handleReadWorkflow(
  request: Request,
  workflow: CallRouteWorkflow
): Promise<NextResponse> {
  const price = Number(workflow.priceUsdcPerCall ?? "0");
  const isPaid = price > 0;

  // Scanner discoverability: on a paid workflow, emit 402 before parsing or
  // validating the body. Scanners probe paid endpoints with empty/invalid
  // bodies and rely on the 402 response (with X-PAYMENT-REQUIREMENTS and
  // WWW-Authenticate: Payment headers) to catalog the resource.
  if (isPaid && detectProtocol(request) === null) {
    return handlePaidWorkflow(request, workflow, {});
  }

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return parsed.error;
  }
  const body = parsed.body;

  const bodyError = validateBody(workflow, body);
  if (bodyError) {
    return bodyError;
  }

  if (isPaid) {
    return handlePaidWorkflow(request, workflow, body);
  }
  return createAndStartExecution(request, workflow, body);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  try {
    const { rejected, rateLimit } = checkCallRateLimit(request);
    if (rejected) {
      return rejected;
    }

    const { slug } = await params;

    const workflow = await lookupWorkflow(slug);
    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: HttpStatus.NOT_FOUND, headers: corsHeaders }
      );
    }

    // The lookup already excluded the hard-gone states (soft-deleted, owner
    // deactivated) as 404. A listed-but-disabled workflow still exists and is
    // publicly discoverable, so report it as temporarily unavailable rather
    // than a misleading "not found" - mirrors the webhook's disabled-vs-gone
    // split, and leaks nothing since the listing is already public.
    if (!workflow.enabled) {
      return NextResponse.json(
        {
          error: "Workflow temporarily unavailable",
          message: "The workflow owner has disabled this workflow.",
        },
        { status: HttpStatus.SERVICE_UNAVAILABLE, headers: corsHeaders }
      );
    }

    if (workflow.workflowType === "write") {
      return applyRateLimitHeaders(
        await handleWriteWorkflow(request, workflow),
        rateLimit
      );
    }

    return applyRateLimitHeaders(
      await handleReadWorkflow(request, workflow),
      rateLimit
    );
  } catch (err) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[x402/call] Unexpected error in call route",
      err,
      { endpoint: "/api/mcp/workflows/[slug]/call" }
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR, headers: corsHeaders }
    );
  }
}
