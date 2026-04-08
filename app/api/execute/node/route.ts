import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { integrations } from "@/lib/db/schema";
import { getErrorMessage } from "@/lib/utils";
import type { ResolvedAction } from "../_lib/action-resolver";
import { resolveAction } from "../_lib/action-resolver";
import type { ApiKeyContext } from "../_lib/auth";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  createExecution,
  failExecution,
  markRunning,
  redactInput,
  setRetryCount,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import {
  executeWithRetry,
  genericRetryOptions,
  type TransactionResult,
  transactionRetryOptions,
} from "../_lib/retry";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import type { NodeExecuteRequest, RetryConfig } from "../_lib/types";
import { requireWallet } from "../_lib/wallet-check";

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
  retryCount: number
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
    return NextResponse.json(
      {
        executionId,
        status: "failed",
        error: errorMsg,
        ...(retryCount > 0 ? { retryCount } : {}),
      },
      { status: 422 }
    );
  }

  const completeParams: Parameters<typeof completeExecution>[1] = {
    output: output ?? {},
  };

  if (isTransactionResult(output)) {
    completeParams.transactionHash = output.transactionHash;
    completeParams.gasUsedWei = output.gasUsed;
    completeParams.gasPriceWei = output.effectiveGasPrice;
  }

  await completeExecution(executionId, completeParams);

  return NextResponse.json(
    {
      executionId,
      status: "completed",
      result: output,
      ...(retryCount > 0 ? { retryCount } : {}),
    },
    { status: isTransactionResult(output) ? 202 : 200 }
  );
}

async function executeNode(
  data: NodeExecuteRequest,
  resolved: ResolvedAction,
  apiKeyCtx: ApiKeyContext,
  preCreatedExecutionId?: string
): Promise<NextResponse> {
  const { config, integrationId, network, retry } = data;

  let executionId: string;
  if (preCreatedExecutionId) {
    executionId = preCreatedExecutionId;
  } else {
    const redactedInput = redactInput({
      actionType: data.actionType,
      ...config,
    });
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
    ...config,
    ...(integrationId ? { integrationId } : {}),
    ...(network ? { network } : {}),
    _context: {
      executionId,
      nodeId: executionId,
      nodeName: resolved.label,
      nodeType: "action",
      organizationId: apiKeyCtx.organizationId,
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
      return NextResponse.json(
        { error: "Internal error: step function not found" },
        { status: 500 }
      );
    }

    const invokeResult = await invokeStep(
      stepFn,
      stepInput,
      retry,
      Boolean(network)
    );

    if (invokeResult.retryCount > 0) {
      await setRetryCount(executionId, invokeResult.retryCount);
    }

    if (!invokeResult.ok) {
      await failExecution(executionId, invokeResult.error);
      return NextResponse.json(
        {
          executionId,
          status: "failed",
          error: invokeResult.error,
          ...(invokeResult.retryCount > 0
            ? { retryCount: invokeResult.retryCount }
            : {}),
        },
        { status: 422 }
      );
    }

    return await handleResult(
      executionId,
      invokeResult.result,
      invokeResult.retryCount
    );
  } catch (err: unknown) {
    const errorMsg = getErrorMessage(err);
    await failExecution(executionId, errorMsg);
    return NextResponse.json(
      { executionId, status: "failed", error: errorMsg },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateRequest(body);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { actionType, integrationId, network } = validation.data;

  const resolved = resolveAction(actionType);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown action type: ${actionType}` },
      { status: 400 }
    );
  }

  if (integrationId) {
    const owned = await verifyIntegrationOwnership(
      integrationId,
      apiKeyCtx.organizationId
    );
    if (!owned) {
      return NextResponse.json(
        {
          error:
            "Integration not found or does not belong to this organization",
        },
        { status: 403 }
      );
    }
  }

  if (network) {
    const walletError = await requireWallet(apiKeyCtx.organizationId);
    if (walletError) {
      return walletError;
    }

    const redactedInput = redactInput({
      actionType: validation.data.actionType,
      ...validation.data.config,
    });
    const reserve = await checkAndReserveExecution({
      organizationId: apiKeyCtx.organizationId,
      apiKeyId: apiKeyCtx.apiKeyId,
      type: resolved.actionType,
      network,
      input: redactedInput,
    });
    if (!reserve.allowed) {
      return NextResponse.json({ error: reserve.reason }, { status: 403 });
    }

    return await executeNode(
      validation.data,
      resolved,
      apiKeyCtx,
      reserve.executionId
    );
  }

  return await executeNode(validation.data, resolved, apiKeyCtx);
}
