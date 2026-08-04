import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi/cache";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { simulateContractCall } from "@/lib/execute/simulate";
import {
  beginIdempotentFromRequest,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import { enforceDirectExecutionConcurrency } from "../_lib/concurrency-limit";
import type { ConditionInput, ConditionResult } from "../_lib/condition";
import { evaluateCondition } from "../_lib/condition";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
  withRejectedSignerOverride,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { parseSimulateFlag } from "../_lib/simulate-flag";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { validateCheckAndExecuteInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

type ActionBody = {
  contractAddress: string;
  functionName: string;
  functionArgs?: string;
  abi?: string;
  gasLimitMultiplier?: string;
};

async function resolveAbiFromField(
  contractAddress: string,
  network: string,
  abi: unknown
): Promise<{ abi: string } | { error: string }> {
  if (typeof abi === "string" && abi.trim() !== "") {
    return { abi };
  }

  try {
    const resolved = await resolveAbi({ contractAddress, network });
    return { abi: resolved.abi };
  } catch (err: unknown) {
    return {
      error: `ABI is required. Could not auto-fetch ABI: ${getErrorMessage(err)}`,
    };
  }
}

async function executeConditionalRead(
  action: ActionBody,
  network: string,
  resolvedWriteAbi: string,
  organizationId: string,
  conditionResult: ConditionResult
): Promise<NextResponse> {
  const readResult = await readContractCore({
    contractAddress: action.contractAddress,
    network,
    abi: resolvedWriteAbi,
    abiFunction: action.functionName,
    functionArgs: action.functionArgs,
    _context: { organizationId },
  });

  if (!readResult.success) {
    return NextResponse.json(
      { error: readResult.error },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  return NextResponse.json(
    { executed: true, conditionResult, result: readResult.result },
    { status: HttpStatus.OK }
  );
}

async function simulateConditionalWrite(
  action: ActionBody,
  network: string,
  resolvedWriteAbi: string,
  organizationId: string,
  conditionResult: ConditionResult
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }
  const result = await simulateContractCall({
    organizationId,
    network,
    contractAddress: action.contractAddress,
    abi: resolvedWriteAbi,
    functionName: action.functionName,
    functionArgs: action.functionArgs,
  });
  // `executed` reflects "the action would have run successfully" rather
  // than "we reached the action step". A reverted simulate means a real
  // broadcast would have reverted too, so executed is false.
  return NextResponse.json(
    { ...result, executed: !result.wouldRevert, conditionResult },
    { status: result.wouldRevert ? HttpStatus.BAD_REQUEST : HttpStatus.OK }
  );
}

async function executeConditionalWrite(
  action: ActionBody,
  network: string,
  resolvedWriteAbi: string,
  organizationId: string,
  apiKeyId: string,
  fullBody: Record<string, unknown>,
  conditionResult: ConditionResult,
  idem: IdempotencyOutcome | null
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    // Pre-broadcast gating failure: release for a clean retry.
    return recordIdempotentResponse(idem, walletError, "release");
  }

  const redactedInput = redactInput(
    withRejectedSignerOverride(fullBody, fullBody)
  );
  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "check-and-execute",
    network,
    input: redactedInput,
    // The conditional write never forwards native value (writeContractCore is
    // called without ethValue), so nothing is charged to the value cap here.
    reserved: { kind: "evm", valueWei: "0" },
  });
  if (!reserve.allowed) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { error: reserve.reason },
        { status: HttpStatus.FORBIDDEN }
      ),
      "release"
    );
  }
  const { executionId } = reserve;

  await markRunning(executionId);

  const result = await withIdempotencyHeartbeat(idem, () =>
    writeContractCore({
      contractAddress: action.contractAddress,
      network,
      abi: resolvedWriteAbi,
      abiFunction: action.functionName,
      functionArgs: action.functionArgs,
      gasLimitMultiplier: action.gasLimitMultiplier,
      _context: { organizationId },
    })
  );

  // completeExecution independently re-verifies the claimed transaction
  // against the chain (KEEP-966) -- its returned outcome, not result.success,
  // is authoritative for the response and idempotency cache.
  let outcome: { status: "completed" | "failed"; error?: string } = {
    status: "failed",
    error: result.success ? undefined : result.error,
  };
  if (result.success) {
    outcome = await completeExecution(executionId, {
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      chainId: result.chainId,
      gasUsedWei: result.gasUsed,
      gasPriceWei: result.effectiveGasPrice,
      output: result as unknown as Record<string, unknown>,
    });
  } else {
    // A failure that already reached the chain carries its hash,
    // so the execution records which transaction failed and what the chain
    // said about it, rather than leaving the hash only inside the message.
    await failExecution(executionId, result.error, {
      transactionHash: result.transactionHash,
      chainId: result.chainId,
      sponsored: result.sponsored,
    });
  }

  return recordIdempotentResponse(
    idem,
    NextResponse.json(
      {
        executionId,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        executed: true,
        conditionResult,
      },
      { status: HttpStatus.ACCEPTED }
    ),
    outcome.status === "completed" ? "success" : "failed"
  );
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const validation = validateCheckAndExecuteInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, {
      status: HttpStatus.BAD_REQUEST,
    });
  }

  // KEEP-490: chainId is the canonical input; network is a deprecated alias.
  const network = String(body.chainId ?? body.network ?? "");
  const condition = body.condition as ConditionInput;
  const action = body.action as ActionBody;

  const readAbiResult = await resolveAbiFromField(
    body.contractAddress as string,
    network,
    body.abi
  );
  if ("error" in readAbiResult) {
    return NextResponse.json(
      { error: readAbiResult.error, field: "abi" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const readResult = await readContractCore({
    contractAddress: body.contractAddress as string,
    network,
    abi: readAbiResult.abi,
    abiFunction: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    _context: { organizationId: apiKeyCtx.organizationId },
  });

  if (!readResult.success) {
    return NextResponse.json(
      { error: readResult.error },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const conditionResult = evaluateCondition(readResult.result, condition);

  if (!conditionResult.met) {
    return NextResponse.json(
      { executed: false, conditionResult },
      { status: HttpStatus.OK }
    );
  }

  const writeAbiResult = await resolveAbiFromField(
    action.contractAddress,
    network,
    action.abi
  );
  if ("error" in writeAbiResult) {
    return NextResponse.json(
      { error: writeAbiResult.error, field: "action.abi" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const actionAbiParsed = JSON.parse(writeAbiResult.abi) as Array<{
    type?: string;
    name?: string;
    stateMutability?: string;
  }>;
  const actionFn = actionAbiParsed.find((f) => f.name === action.functionName);

  if (!actionFn) {
    return NextResponse.json(
      {
        error: `Function "${action.functionName}" not found in action ABI`,
        field: "action.functionName",
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const isReadOnly =
    actionFn.stateMutability === "view" || actionFn.stateMutability === "pure";

  if (isReadOnly) {
    return applyRateLimitHeaders(
      await executeConditionalRead(
        action,
        network,
        writeAbiResult.abi,
        apiKeyCtx.organizationId,
        conditionResult
      ),
      rateLimit
    );
  }

  // Dry-run path on the action: still evaluates the condition (which is
  // read-only), but simulates the write instead of broadcasting.
  // Triggered by strict boolean `simulate: true` on the body.
  const simulateFlag = parseSimulateFlag(body);
  if (!simulateFlag.ok) {
    return NextResponse.json(
      { error: simulateFlag.error, field: "simulate" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }
  if (simulateFlag.simulate) {
    return applyRateLimitHeaders(
      await simulateConditionalWrite(
        action,
        network,
        writeAbiResult.abi,
        apiKeyCtx.organizationId,
        conditionResult
      ),
      rateLimit
    );
  }

  // Concurrency back-pressure: gate the broadcasting write path only (reads and
  // simulations already returned above). Before reserving the idempotency key so
  // a 429 leaves no key to release.
  const concurrency = await enforceDirectExecutionConcurrency(
    apiKeyCtx.organizationId
  );
  if (concurrency) {
    return concurrency;
  }

  // Idempotency applies only to the broadcasting write path.
  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: "execute:check-and-execute",
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

  return applyRateLimitHeaders(
    await executeConditionalWrite(
      action,
      network,
      writeAbiResult.abi,
      apiKeyCtx.organizationId,
      apiKeyCtx.apiKeyId,
      body,
      conditionResult,
      idem
    ),
    rateLimit
  );
}
