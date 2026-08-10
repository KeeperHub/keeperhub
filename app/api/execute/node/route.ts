import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { integrations } from "@/lib/db/schema";
import {
  beginIdempotentFromRequest,
  PROCESSING_TTL_MS as IDEMPOTENCY_PROCESSING_TTL_MS,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getErrorMessage } from "@/lib/utils";
import type { ResolvedAction } from "../_lib/action-resolver";
import { resolveAction } from "../_lib/action-resolver";
import type { ApiKeyContext } from "../_lib/auth";
import { validateApiKey } from "../_lib/auth";
import { enforceDirectExecutionConcurrency } from "../_lib/concurrency-limit";
import {
  completeExecution,
  createExecution,
  failExecution,
  markRunning,
  redactInput,
  setRetryCount,
  withRejectedSignerOverride,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { parseNodeNativeValueWei } from "../_lib/reserved-value";
import {
  DEFAULT_TIMEOUT_MS as DEFAULT_RETRY_TIMEOUT_MS,
  executeWithRetry,
  genericRetryOptions,
  type TransactionResult,
  transactionRetryOptions,
} from "../_lib/retry";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import type { NodeExecuteRequest, RetryConfig } from "../_lib/types";
import { requireWallet } from "../_lib/wallet-check";

// The worst-case retry budget (timeoutMs x attempts) must not exceed the
// idempotency processing-lock TTL, so a single request cannot outlive its own
// reservation and have a reclaimer take the slot mid-flight.
const MAX_RETRY_BUDGET_MS = IDEMPOTENCY_PROCESSING_TTL_MS;

function validateRetryConfig(
  raw: unknown
): { valid: true; data: RetryConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "retry must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  if (
    r.maxRetries !== undefined &&
    (typeof r.maxRetries !== "number" || r.maxRetries < 0 || r.maxRetries > 10)
  ) {
    return {
      valid: false,
      error: "retry.maxRetries must be a number between 0 and 10",
    };
  }
  if (
    r.timeoutMs !== undefined &&
    (typeof r.timeoutMs !== "number" ||
      r.timeoutMs < 1000 ||
      r.timeoutMs > 600_000)
  ) {
    return {
      valid: false,
      error: "retry.timeoutMs must be a number between 1000 and 600000",
    };
  }
  if (
    r.gasBumpPercent !== undefined &&
    (typeof r.gasBumpPercent !== "number" ||
      r.gasBumpPercent < 0 ||
      r.gasBumpPercent > 100)
  ) {
    return {
      valid: false,
      error: "retry.gasBumpPercent must be a number between 0 and 100",
    };
  }

  const attempts = ((r.maxRetries as number | undefined) ?? 0) + 1;
  const perAttempt =
    (r.timeoutMs as number | undefined) ?? DEFAULT_RETRY_TIMEOUT_MS;
  if (attempts * perAttempt > MAX_RETRY_BUDGET_MS) {
    return {
      valid: false,
      error: `retry budget (timeoutMs x (maxRetries + 1)) must not exceed ${MAX_RETRY_BUDGET_MS}ms`,
    };
  }

  return {
    valid: true,
    data: {
      maxRetries: r.maxRetries as number | undefined,
      timeoutMs: r.timeoutMs as number | undefined,
      gasBumpPercent: r.gasBumpPercent as number | undefined,
    },
  };
}

function validateRequest(
  body: unknown
): { valid: true; data: NodeExecuteRequest } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const req = body as Record<string, unknown>;

  if (typeof req.actionType !== "string" || req.actionType.trim() === "") {
    return { valid: false, error: "actionType is required" };
  }

  if (
    !req.config ||
    typeof req.config !== "object" ||
    Array.isArray(req.config)
  ) {
    return { valid: false, error: "config must be a JSON object" };
  }

  if (
    req.integrationId !== undefined &&
    typeof req.integrationId !== "string"
  ) {
    return { valid: false, error: "integrationId must be a string" };
  }

  if (req.network !== undefined && typeof req.network !== "string") {
    return { valid: false, error: "network must be a string" };
  }

  let retry: RetryConfig | undefined;
  if (req.retry !== undefined) {
    const retryResult = validateRetryConfig(req.retry);
    if (!retryResult.valid) {
      return retryResult;
    }
    retry = retryResult.data;
  }

  return {
    valid: true,
    data: {
      actionType: req.actionType as string,
      config: req.config as Record<string, unknown>,
      integrationId: req.integrationId as string | undefined,
      network: req.network as string | undefined,
      retry,
    },
  };
}

async function verifyIntegrationOwnership(
  integrationId: string,
  organizationId: string
): Promise<boolean> {
  const result = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId)
      )
    )
    .limit(1);

  return result.length > 0;
}

function isTransactionResult(output: unknown): output is {
  transactionHash: string;
  gasUsed: string;
  gasUsedUnits?: string;
  effectiveGasPrice?: string;
  chainId?: number;
} {
  if (!output || typeof output !== "object") {
    return false;
  }
  const obj = output as Record<string, unknown>;
  return (
    typeof obj.transactionHash === "string" && typeof obj.gasUsed === "string"
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Step functions have varying signatures
type StepFn = (input: any) => Promise<unknown>;

type InvokeResult =
  | { ok: true; result: unknown; retryCount: number }
  | { ok: false; error: string; retryCount: number };

function unwrapRetryResult<T>(
  retryResult: Awaited<ReturnType<typeof executeWithRetry<T>>>
): InvokeResult {
  if (
    retryResult.outcome === "timeout" ||
    retryResult.outcome === "exhausted"
  ) {
    return {
      ok: false,
      error: retryResult.error,
      retryCount: retryResult.retryCount,
    };
  }
  return {
    ok: true,
    result: retryResult.result,
    retryCount: retryResult.retryCount,
  };
}

async function invokeStep(
  stepFn: StepFn,
  stepInput: Record<string, unknown>,
  retry: RetryConfig | undefined,
  isWeb3: boolean
): Promise<InvokeResult> {
  if (retry) {
    if (isWeb3) {
      const retryResult = await executeWithRetry<TransactionResult>(
        async () => (await stepFn(stepInput)) as TransactionResult,
        retry,
        transactionRetryOptions
      );
      return unwrapRetryResult(retryResult);
    }
    const retryResult = await executeWithRetry<unknown>(
      async () => stepFn(stepInput),
      retry,
      genericRetryOptions
    );
    return unwrapRetryResult(retryResult);
  }
  const result = await stepFn(stepInput);
  return { ok: true, result, retryCount: 0 };
}

async function handleResult(
  executionId: string,
  result: unknown,
  retryCount: number,
  idem: IdempotencyOutcome | null
): Promise<NextResponse> {
  const output = result as Record<string, unknown> | undefined;
  const success =
    output && typeof output === "object" && "success" in output
      ? (output.success as boolean)
      : true;

  if (!success) {
    const errorMsg =
      output && "error" in output ? String(output.error) : "Execution failed";
    await failExecution(executionId, errorMsg);
    // The step ran (possibly broadcasting): finalize as failed so a retry
    // replays the failure instead of re-executing.
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          executionId,
          status: "failed",
          error: errorMsg,
          ...(retryCount > 0 ? { retryCount } : {}),
        },
        { status: HttpStatus.UNPROCESSABLE_ENTITY }
      ),
      "failed"
    );
  }

  const completeParams: Parameters<typeof completeExecution>[1] = {
    output: output ?? {},
  };

  if (isTransactionResult(output)) {
    completeParams.transactionHash = output.transactionHash;
    completeParams.gasUsedWei = output.gasUsed;
    completeParams.gasPriceWei = output.effectiveGasPrice;
    completeParams.chainId = output.chainId;
  }

  // KEEP-966: completeExecution independently re-verifies transactionHash
  // against the chain when present -- regardless of whether this step's
  // return value carried a literal `success` key at all (the earlier default
  // in this function treats an absent field as success). Its returned
  // outcome, not that default, is authoritative for the response.
  const outcome = await completeExecution(executionId, completeParams);

  // Anything other than a verified success is reported as such. `unconfirmed`
  // is grouped here rather than with the success response because the
  // transaction is on chain but unverified; reporting it as completed would
  // assert an outcome we do not have. It is non-terminal, so the caller polls
  // the status endpoint and the reconciler settles the row.
  if (outcome.status !== "completed") {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          executionId,
          status: outcome.status,
          error: outcome.error ?? "On-chain verification failed",
          ...(retryCount > 0 ? { retryCount } : {}),
        },
        { status: HttpStatus.UNPROCESSABLE_ENTITY }
      ),
      "failed"
    );
  }

  return recordIdempotentResponse(
    idem,
    NextResponse.json(
      {
        executionId,
        status: "completed",
        result: output,
        ...(retryCount > 0 ? { retryCount } : {}),
      },
      {
        status: isTransactionResult(output)
          ? HttpStatus.ACCEPTED
          : HttpStatus.OK,
      }
    ),
    "success"
  );
}

// Caller-supplied config keys the route must own, not the caller. `network`
// and `integrationId` are resolved and gated by the route itself; `_context`
// is injected server-side. `web3Connection` selects the signer mode in
// resolveSignerForNode (lib/safe/signer-resolver.ts): a direct-execution
// caller must NOT be able to set web3Connection='eoa' to short-circuit to the
// org's Turnkey EOA and bypass the org Safe's Zodiac Roles policy on
// org-custodied writes. With it absent, resolveSignerForNode falls back to the
// "default" branch (resolveSignerMode org-policy path), honouring the Safe +
// active Role. The sibling execute routes never forward web3Connection either,
// so this keeps /api/execute/node no weaker. Stripping all four in one place
// keeps the step input and the persisted audit input in lockstep.
function stripReservedConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const {
    network: _ignoredNetwork,
    integrationId: _ignoredIntegrationId,
    web3Connection: _ignoredWeb3Connection,
    _context: _ignoredContext,
    ...rest
  } = config;
  return rest;
}

async function executeNode(
  data: NodeExecuteRequest,
  resolved: ResolvedAction,
  apiKeyCtx: ApiKeyContext,
  idem: IdempotencyOutcome | null,
  preCreatedExecutionId?: string,
  resolvedRefs?: { network?: string; integrationId?: string }
): Promise<NextResponse> {
  const { config, retry } = data;
  const network = resolvedRefs?.network;
  const integrationId = resolvedRefs?.integrationId;

  const safeConfig = stripReservedConfig(config);

  let executionId: string;
  if (preCreatedExecutionId) {
    executionId = preCreatedExecutionId;
  } else {
    const redactedInput = redactInput(
      withRejectedSignerOverride(
        { actionType: data.actionType, ...safeConfig },
        config
      )
    );
    const created = await createExecution({
      organizationId: apiKeyCtx.organizationId,
      apiKeyId: apiKeyCtx.apiKeyId,
      type: resolved.actionType,
      network,
      input: redactedInput,
    });
    executionId = created.executionId;
  }

  await markRunning(executionId);

  const stepInput = {
    ...safeConfig,
    ...(integrationId ? { integrationId } : {}),
    ...(network ? { network } : {}),
    _context: {
      executionId,
      nodeId: executionId,
      nodeName: resolved.label,
      nodeType: "action",
      organizationId: apiKeyCtx.organizationId,
      // A pre-created execution id means the caller already reserved this
      // execution's value against the cap (checkAndReserveExecution, in the
      // networked branch below). Flag it so a value-moving step wrapper does
      // not reserve a second time and double-charge the cap.
      valueCapReserved: Boolean(preCreatedExecutionId),
    },
  };

  try {
    const module = await resolved.importer.importer();
    const stepFn = module[resolved.importer.stepFunction] as StepFn | undefined;

    if (typeof stepFn !== "function") {
      await failExecution(
        executionId,
        `Step function not found: ${resolved.importer.stepFunction}`
      );
      // Never reached the step: release for a clean retry.
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: "Internal error: step function not found" },
          { status: HttpStatus.INTERNAL_SERVER_ERROR }
        ),
        "release"
      );
    }

    const invokeResult = await withIdempotencyHeartbeat(idem, () =>
      invokeStep(stepFn, stepInput, retry, Boolean(network))
    );

    if (invokeResult.retryCount > 0) {
      await setRetryCount(executionId, invokeResult.retryCount);
    }

    if (!invokeResult.ok) {
      await failExecution(executionId, invokeResult.error);
      // The step ran (possibly broadcasting): finalize as failed.
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          {
            executionId,
            status: "failed",
            error: invokeResult.error,
            ...(invokeResult.retryCount > 0
              ? { retryCount: invokeResult.retryCount }
              : {}),
          },
          { status: HttpStatus.UNPROCESSABLE_ENTITY }
        ),
        "failed"
      );
    }

    return await handleResult(
      executionId,
      invokeResult.result,
      invokeResult.retryCount,
      idem
    );
  } catch (err: unknown) {
    const errorMsg = getErrorMessage(err);
    await failExecution(executionId, errorMsg);
    // A thrown error may have left a tx mid-broadcast: finalize as failed.
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { executionId, status: "failed", error: errorMsg },
        { status: HttpStatus.INTERNAL_SERVER_ERROR }
      ),
      "failed"
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if ("error" in apiKeyCtx) {
    return NextResponse.json(
      { error: apiKeyCtx.error },
      { status: apiKeyCtx.status }
    );
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rateLimit
    );
  }

  const executionGuard = await enforceExecutionLimit(apiKeyCtx.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const validation = validateRequest(body);
  if (!validation.valid) {
    return NextResponse.json(
      { error: validation.error },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const { actionType, config, integrationId, network } = validation.data;

  // Gating keys can ride inside caller config; merge them in so ownership,
  // wallet, and spending-cap checks cannot be bypassed by nesting them there.
  const configNetwork =
    typeof config.network === "string" && config.network.trim() !== ""
      ? config.network
      : undefined;
  const configIntegrationId =
    typeof config.integrationId === "string" &&
    config.integrationId.trim() !== ""
      ? config.integrationId
      : undefined;
  const effectiveNetwork = network ?? configNetwork;
  const effectiveIntegrationId = integrationId ?? configIntegrationId;

  const resolved = resolveAction(actionType);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown action type: ${actionType}` },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  if (effectiveIntegrationId) {
    const owned = await verifyIntegrationOwnership(
      effectiveIntegrationId,
      apiKeyCtx.organizationId
    );
    if (!owned) {
      return NextResponse.json(
        {
          error:
            "Integration not found or does not belong to this organization",
        },
        { status: HttpStatus.FORBIDDEN }
      );
    }
  }

  const resolvedRefs = {
    network: effectiveNetwork,
    integrationId: effectiveIntegrationId,
  };

  // Idempotency: reserve the key before any state-changing node execution.
  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: `execute:node:${actionType}`,
    requestBody: body,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return applyRateLimitHeaders(
        NextResponse.json(early.body, { status: early.status }),
        rateLimit
      );
    }
  }

  if (effectiveNetwork) {
    const walletError = await requireWallet(apiKeyCtx.organizationId);
    if (walletError) {
      // Pre-broadcast gating failure: release for a clean retry.
      return recordIdempotentResponse(idem, walletError, "release");
    }

    // Concurrency back-pressure before broadcasting. Release the idempotency
    // key on a 429 so a retry is not blocked by a stale in-progress record.
    const concurrency = await enforceDirectExecutionConcurrency(
      apiKeyCtx.organizationId
    );
    if (concurrency) {
      return recordIdempotentResponse(idem, concurrency, "release");
    }

    // Charge native value moved against the daily cap: transfer-funds forwards
    // `amount`, a contract write forwards `ethValue`. Other actions (token
    // transfer/approve, off-chain steps) move no native value.
    const parsedValue = parseNodeNativeValueWei(
      resolved.importer.stepFunction,
      validation.data.config
    );
    if (!parsedValue.ok) {
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: parsedValue.error },
          { status: HttpStatus.BAD_REQUEST }
        ),
        "release"
      );
    }

    // Strip the same reserved keys executeNode removes so the persisted audit
    // input matches what the step actually received (see stripReservedConfig),
    // but preserve a non-honored web3Connection under _rejectedConfig so the
    // audit log still shows the attempt (see withRejectedSignerOverride).
    const redactedInput = redactInput(
      withRejectedSignerOverride(
        {
          actionType: validation.data.actionType,
          ...stripReservedConfig(validation.data.config),
        },
        validation.data.config
      )
    );
    const reserve = await checkAndReserveExecution({
      organizationId: apiKeyCtx.organizationId,
      apiKeyId: apiKeyCtx.apiKeyId,
      type: resolved.actionType,
      network: effectiveNetwork,
      input: redactedInput,
      reserved:
        parsedValue.kind === "solana"
          ? { kind: "solana", valueLamports: parsedValue.valueLamports }
          : { kind: "evm", valueWei: parsedValue.valueWei },
    });
    if (!reserve.allowed) {
      return applyRateLimitHeaders(
        await recordIdempotentResponse(
          idem,
          NextResponse.json(
            { error: reserve.reason },
            { status: HttpStatus.FORBIDDEN }
          ),
          "release"
        ),
        rateLimit
      );
    }

    // executeNode settles the idempotency record (finalize/failed) per branch.
    return applyRateLimitHeaders(
      await executeNode(
        validation.data,
        resolved,
        apiKeyCtx,
        idem,
        reserve.executionId,
        resolvedRefs
      ),
      rateLimit
    );
  }

  return applyRateLimitHeaders(
    await executeNode(
      validation.data,
      resolved,
      apiKeyCtx,
      idem,
      undefined,
      resolvedRefs
    ),
    rateLimit
  );
}
