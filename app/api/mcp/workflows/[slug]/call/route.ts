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
import type { PaymentDeliverable } from "@/lib/db/schema-payments";
import { classifyExecutionError } from "@/lib/errors/classify";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { HttpStatus } from "@/lib/http-status";
import {
  beginIdempotentFromRequest,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  safeRecordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  checkIpRateLimit,
  getClientIp,
  type RateLimitResult,
} from "@/lib/mcp/rate-limit";
import type { PaymentProtocol } from "@/lib/payments/rails";
import {
  detectProtocol,
  gatePayment,
  type PaymentMeta,
} from "@/lib/payments/router";
import { buildCallCompletionResponse } from "@/lib/payments/x402/execution-wait";
import {
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
import { calculateTotalSteps } from "@/lib/workflow/executor/progress";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE, Idempotency-Key",
  "Access-Control-Expose-Headers": "Payment-Receipt",
} as const;

export function OPTIONS(): NextResponse {
  return NextResponse.json({}, { headers: corsHeaders });
}

type CallIdempotencyStart =
  | { kind: "early"; response: NextResponse }
  | { kind: "proceed"; idem: IdempotencyOutcome | null };

/**
 * Reserve an Idempotency-Key for a paid marketplace call after the payment
 * gate has verified the credential. Scope includes protocol and the verified
 * payer so the same key cannot collide across callers or rails and cannot be
 * forged from an unsigned header. Call only from inside the gatePayment
 * handler factory -- never on a 402 probe, and never before verification.
 *
 * When a key is present but the verified meta has no payer (e.g. MPP wallet
 * omitted `credential.source`), proceed without a reservation rather than
 * returning 400: this helper only runs after settlement on MPP, so rejecting
 * would take funds and deliver nothing.
 */
async function beginCallIdempotency(
  request: Request,
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>,
  payerAddress: string | null,
  protocol: PaymentProtocol
): Promise<CallIdempotencyStart> {
  const key = request.headers.get("Idempotency-Key")?.trim();
  if (!key) {
    return { kind: "proceed", idem: null };
  }
  if (!workflow.organizationId) {
    return { kind: "proceed", idem: null };
  }

  if (!payerAddress) {
    logSystemWarn(
      ErrorCategory.VALIDATION,
      "[x402/call] Idempotency-Key ignored: verified payment has no payer address",
      undefined,
      { workflowId: workflow.id, protocol }
    );
    return { kind: "proceed", idem: null };
  }

  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: workflow.organizationId,
    scope: `mcp-call:${workflow.id}:${protocol}:${payerAddress.toLowerCase()}`,
    requestBody: body,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return {
        kind: "early",
        response: NextResponse.json(early.body, {
          status: early.status,
          headers: corsHeaders,
        }),
      };
    }
  }
  return { kind: "proceed", idem };
}

function completionIdempotencyDisposition(body: {
  status?: string;
}): "success" | "release" {
  return body.status === "running" ? "release" : "success";
}

async function recordCompletionResponse(
  idem: IdempotencyOutcome | null,
  body: { status?: string },
  context: string,
  skipSuccessFinalize = false
): Promise<NextResponse> {
  const response = NextResponse.json(body, { headers: corsHeaders });
  const disposition = completionIdempotencyDisposition(body);
  if (skipSuccessFinalize && disposition === "success") {
    return response;
  }
  return await safeRecordIdempotentResponse(
    idem,
    response,
    disposition,
    context
  );
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
          organizationId: workflow.organizationId,
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

  // Mirrors keeperhub-executor's initializeExecutionProgress (the K8s Job
  // and in-process/SQS dispatch paths already do this before running).
  // Without it, total_steps stays NULL forever and the status endpoint's
  // progress.percentage is stuck at 0 even after a successful run.
  // This sits between the committed payment (recordPayment, above) and
  // start() below -- a display-only column must never be able to abort a
  // paid dispatch, so a transient DB fault here is caught and logged
  // rather than thrown, and execution proceeds to start() regardless.
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: calculateTotalSteps(
        workflow.nodes as WorkflowNode[],
        workflow.edges as WorkflowEdge[]
      ).toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, executionId))
    .catch((err: unknown) => {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[x402/call] Error initializing execution progress",
        err,
        { endpoint: "/api/mcp/workflows/[slug]/call", workflowId: workflow.id }
      );
    });

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

function calldataResponse(deliverable: PaymentDeliverable): NextResponse {
  return NextResponse.json(deliverable, { headers: corsHeaders });
}

/**
 * Payment gate for the write branch.
 *
 * Deliberately not the read branch's handler: there is no execution to
 * prepare, no billable flip to make, and no execution row to finalize on
 * error. The only statement after the gate is a single insert, and the
 * `deliverable` is already computed before we get here -- so the gated
 * handler is structurally incapable of failing to produce what was paid for.
 */
async function gateWriteCall(
  request: Request,
  workflow: CallRouteWorkflow,
  deliverable: PaymentDeliverable | null,
  body: Record<string, unknown> = {}
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

  // Idempotency is reserved inside the handler after the gate has verified
  // the payer. A 402 probe never reaches this factory. MPP finalizes after
  // withReceipt via getIdem so the stored body keeps Payment-Receipt.
  const idemHold: { current: IdempotencyOutcome | null } = { current: null };
  return gatePayment(
    request,
    workflow,
    creatorWalletAddress,
    (meta: PaymentMeta) => {
      return async (_req: NextRequest): Promise<NextResponse> => {
        if (!(deliverable && meta.paymentHash)) {
          // Unreachable: a null deliverable only occurs on the headerless
          // scanner path, where gatePayment short-circuits to the 402 and
          // never invokes this factory, and a gated handler always has a
          // verified credential. Fail closed so a future refactor cannot
          // turn this into a settled-but-undelivered call.
          logSystemError(
            ErrorCategory.WORKFLOW_ENGINE,
            "[x402/call] Write gate reached handler without calldata",
            undefined,
            { workflowId: workflow.id }
          );
          return NextResponse.json(
            { error: "Payment could not be processed" },
            { status: HttpStatus.SERVICE_UNAVAILABLE, headers: corsHeaders }
          );
        }

        const started = await beginCallIdempotency(
          request,
          workflow,
          body,
          meta.payerAddress,
          meta.protocol
        );
        if (started.kind === "early") {
          return started.response;
        }
        const idem = started.idem;
        idemHold.current = idem;

        try {
          await recordPayment({
            workflowId: workflow.id,
            paymentHash: meta.paymentHash,
            executionId: null,
            kind: "calldata",
            deliverable,
            amountUsdc: workflow.priceUsdcPerCall ?? "0",
            payerAddress: meta.payerAddress,
            creatorWalletAddress,
            protocol: meta.protocol,
            chain: meta.chain,
          });
        } catch (err) {
          if (meta.protocol === "mpp") {
            // MPP settles BEFORE this handler runs, and there is no refund
            // path. The caller's funds have already moved, so failing here
            // would take money and deliver nothing. Deliver, and log loudly:
            // a missing earnings row can be reconciled by hand, a stolen
            // payment cannot. Router finalizes via getIdem after withReceipt.
            logSystemError(
              ErrorCategory.DATABASE,
              "[x402/call] Calldata payment row lost after MPP settlement",
              err,
              { workflowId: workflow.id, paymentHash: meta.paymentHash }
            );
            return calldataResponse(deliverable);
          }
          // x402 settles AFTER this handler returns and skips settlement
          // entirely for any >=400 response, so a 503 here means no funds
          // move and the same signature can simply be retried.
          logSystemError(
            ErrorCategory.DATABASE,
            "[x402/call] Failed to record calldata payment, settlement cancelled",
            err,
            { workflowId: workflow.id }
          );
          return await safeRecordIdempotentResponse(
            idem,
            NextResponse.json(
              {
                error:
                  "Payment could not be recorded. No funds were taken -- retry the same request.",
              },
              { status: HttpStatus.SERVICE_UNAVAILABLE, headers: corsHeaders }
            ),
            "release",
            "[x402/call] Idempotency finalize failed after calldata recordPayment error"
          );
        }

        return meta.protocol === "mpp"
          ? calldataResponse(deliverable)
          : await safeRecordIdempotentResponse(
              idem,
              calldataResponse(deliverable),
              "success",
              "[x402/call] Idempotency finalize failed after calldata delivery"
            );
      };
    },
    { getIdem: () => idemHold.current }
  );
}

async function handleWriteWorkflow(
  request: Request,
  workflow: CallRouteWorkflow
): Promise<NextResponse> {
  const price = Number(workflow.priceUsdcPerCall ?? "0");
  const isPaid = price > 0;
  const protocol = isPaid ? detectProtocol(request) : null;

  // Scanner discoverability, mirroring handleReadWorkflow: on a paid listing
  // with no (or a conflicting) payment header, emit the 402 challenge before
  // the body is read at all. Scanners probe with an empty body and must see
  // 402, never the 400 that calldata generation would produce.
  if (isPaid && protocol !== "x402" && protocol !== "mpp") {
    return await gateWriteCall(request, workflow, null);
  }

  // Everything that can fail runs here, before any money can move. This is
  // the money-safety invariant: on MPP settlement is already final by the
  // time the gated handler runs, so a fallible step after the gate would be
  // an unrefundable charge for a call that delivered nothing.
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

  const deliverable: PaymentDeliverable = {
    type: "calldata",
    to: result.to,
    data: result.data,
    value: result.value,
  };

  if (!isPaid) {
    return calldataResponse(deliverable);
  }

  return await gateWriteCall(request, workflow, deliverable, writeBody);
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

  // Reservation happens inside the handler after the gate verifies the payer.
  // 402 probes never reach that factory, so they cannot lock the key. MPP
  // finalizes after withReceipt via getIdem so the stored body keeps
  // Payment-Receipt.
  const idemHold: { current: IdempotencyOutcome | null } = { current: null };
  return gatePayment(
    request,
    workflow,
    creatorWalletAddress,
    (meta: PaymentMeta) => {
      return async (_req: NextRequest): Promise<NextResponse> => {
        const started = await beginCallIdempotency(
          request,
          workflow,
          body,
          meta.payerAddress,
          meta.protocol
        );
        if (started.kind === "early") {
          return started.response;
        }
        const idem = started.idem;
        idemHold.current = idem;

        const prepared = await prepareExecution(request, workflow, body);
        if ("error" in prepared) {
          return await safeRecordIdempotentResponse(
            idem,
            prepared.error,
            "release",
            "[x402/call] Idempotency finalize failed after prepareExecution error"
          );
        }
        const { executionId } = prepared;

        // The router computed this once from the credential it verified. Do
        // not re-derive it here: a fallback to executionId on a missing header
        // would mint a unique hash per call and silently defeat the DB-level
        // idempotency guarantee on workflow_payments.payment_hash.
        const paymentHash = meta.paymentHash ?? executionId;

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
          if (meta.protocol === "mpp") {
            // MPP settles BEFORE this handler runs. Deliver anyway and log
            // loudly: a missing earnings row can be reconciled by hand.
            // Router finalizes via getIdem after withReceipt.
            logSystemError(
              ErrorCategory.DATABASE,
              "[x402/call] Execution payment row lost after MPP settlement",
              err,
              { workflowId: workflow.id, executionId }
            );
            await startExecutionInBackground(workflow, body, executionId);
            const responseBody = await withIdempotencyHeartbeat(idem, () =>
              buildCallCompletionResponse(executionId, workflow.outputMapping)
            );
            return await recordCompletionResponse(
              idem,
              responseBody,
              "[x402/call] Idempotency finalize failed after MPP recordPayment error",
              true
            );
          }
          // x402 settles AFTER this handler returns and skips settlement
          // entirely for any >=400 response, so a 503 here means no funds
          // move and the same signature can simply be retried.
          logSystemError(
            ErrorCategory.DATABASE,
            "[x402/call] Failed to record execution payment, settlement cancelled",
            err,
            { workflowId: workflow.id, executionId }
          );
          return await safeRecordIdempotentResponse(
            idem,
            NextResponse.json(
              {
                error:
                  "Payment could not be recorded. No funds were taken -- retry the same request.",
              },
              { status: HttpStatus.SERVICE_UNAVAILABLE, headers: corsHeaders }
            ),
            "release",
            "[x402/call] Idempotency finalize failed after recordPayment error"
          );
        }

        await startExecutionInBackground(workflow, body, executionId);

        const responseBody = await withIdempotencyHeartbeat(idem, () =>
          buildCallCompletionResponse(executionId, workflow.outputMapping)
        );
        return await recordCompletionResponse(
          idem,
          responseBody,
          "[x402/call] Idempotency finalize failed after paid execution start",
          meta.protocol === "mpp"
        );
      };
    },
    { getIdem: () => idemHold.current }
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
      { error: "Internal server error" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR, headers: corsHeaders }
    );
  }
}
