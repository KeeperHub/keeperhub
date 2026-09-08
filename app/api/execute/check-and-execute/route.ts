import { simulationHttpStatus } from "@/app/api/execute/_lib/simulation-response";
import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi/cache";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
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
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
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
  type CompleteExecutionOutcome,
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

const INTEGER_ABI_TYPE_REGEX = /^(?:u?int)(\d{0,3})$/u;
const FIXED_BYTES_ABI_TYPE_REGEX = /^bytes(?:[1-9]|[12]\d|3[0-2])$/u;

function isIntegerAbiType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }

  const match = INTEGER_ABI_TYPE_REGEX.exec(type);
  if (!match) {
    return false;
  }

  const widthText = match[1];
  if (widthText === "") {
    return true;
  }

  const width = Number(widthText);
  return (
    String(width) === widthText && width >= 8 && width <= 256 && width % 8 === 0
  );
}

function isFixedBytesAbiType(type: unknown): boolean {
  return typeof type === "string" && FIXED_BYTES_ABI_TYPE_REGEX.test(type);
}

type CheckOutputError = {
  error: string;
  field: "condition.operator" | "functionName";
  details: string;
};

function unsupportedCheckOutputError(
  abi: string,
  functionName: string,
  operator: ConditionInput["operator"]
): CheckOutputError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi);
  } catch {
    // readContractCore preserves the established malformed-ABI response.
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const checkFunction = findAbiFunction(parsed as AbiItem[], functionName);
  if (!checkFunction) {
    // readContractCore preserves the established function-not-found response.
    return null;
  }

  const { outputs } = checkFunction;
  if (!Array.isArray(outputs) || outputs.length !== 1) {
    return {
      error: "Unsupported check function output",
      field: "functionName",
      details:
        "The check function must return exactly one Solidity integer, address, or bytes1..bytes32 value.",
    };
  }

  const outputType = outputs[0]?.type;
  if (isIntegerAbiType(outputType)) {
    return null;
  }

  if (outputType === "address" || isFixedBytesAbiType(outputType)) {
    if (operator === "eq" || operator === "neq") {
      return null;
    }

    return {
      error: "Unsupported condition operator for check output",
      field: "condition.operator",
      details: "address and bytes1..bytes32 outputs support only eq and neq.",
    };
  }

  return {
    error: "Unsupported check function output",
    field: "functionName",
    details:
      "The check function must return exactly one Solidity integer, or one address or bytes1..bytes32 value with eq or neq.",
  };
}

// Every dry-run response says whether the run itself completed, so a caller
// never has to read an absent `success` as a failure. `wouldRevert` is not in
// here on purpose: it is a claim about a specific call, so it is only set on
// the branches that actually made one.
const SIMULATION_RAN = { success: true, status: "simulated" } as const;

async function executeConditionalRead(
  action: ActionBody,
  network: string,
  resolvedWriteAbi: string,
  organizationId: string,
  conditionResult: ConditionResult,
  simulate: boolean
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

  // No `wouldRevert`: nothing was written or estimated here, so the field has
  // no answer to give about this call.
  return NextResponse.json(
    simulate
      ? {
          ...SIMULATION_RAN,
          executed: true,
          conditionResult,
          result: readResult.result,
        }
      : { executed: true, conditionResult, result: readResult.result },
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
    { ...result, executed: result.success, conditionResult },
    { status: simulationHttpStatus(result) }
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
  idem: IdempotencyOutcome | null,
  paygOverflow: boolean
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
    paygOverflow,
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
  let outcome: CompleteExecutionOutcome = {
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
    // A failure that already reached the chain carries its hash, so the
    // execution records which transaction failed and what the chain said about
    // it. failExecution decides from that receipt whether this is terminal or
    // a broadcast that may still land, and its verdict is authoritative.
    const settled = await failExecution(executionId, result.error, {
      transactionHash: result.transactionHash,
      chainId: result.chainId,
      sponsored: result.sponsored,
    });
    outcome = { status: settled.status, error: result.error };
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

  // Parsed before the scope gate because the required scope depends on
  // whether this is a dry run.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const simulateFlag = parseSimulateFlag(body);
  if (!simulateFlag.ok) {
    return NextResponse.json(
      { error: simulateFlag.error, field: "simulate" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // A dry run never signs, broadcasts, or reserves, so mcp:read satisfies it.
  // parseSimulateFlag is strict-boolean, so a non-boolean `simulate` is
  // rejected above rather than downgrading the requirement.
  const scopeError = requireScope(
    apiKeyCtx.scope,
    simulateFlag.simulate ? SCOPE_MCP_READ : SCOPE_MCP_WRITE,
    {
      organizationId: apiKeyCtx.organizationId,
      credentialId: apiKeyCtx.apiKeyId,
      credentialType: apiKeyCtx.credentialType,
      endpoint: "/api/execute/check-and-execute",
    }
  );
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

  const checkFunctionOutputError = unsupportedCheckOutputError(
    readAbiResult.abi,
    body.functionName as string,
    condition.operator
  );
  if (checkFunctionOutputError) {
    return NextResponse.json(checkFunctionOutputError, {
      status: HttpStatus.BAD_REQUEST,
    });
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

  if (!conditionResult) {
    return NextResponse.json(
      {
        error: "Check function result could not be compared",
        field: "functionName",
        details:
          "The check function must return one supported scalar value for the selected operator.",
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  if (!conditionResult.met) {
    // No `wouldRevert`: the action was never encoded or estimated, so we have
    // no evidence either way and will not invent one.
    return NextResponse.json(
      simulateFlag.simulate
        ? { ...SIMULATION_RAN, executed: false, conditionResult }
        : { executed: false, conditionResult },
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
        conditionResult,
        simulateFlag.simulate
      ),
      rateLimit
    );
  }

  // Dry-run path on the action: still evaluates the condition (which is
  // read-only), but simulates the write instead of broadcasting.
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
      idem,
      executionGuard.limitResult?.paygOverflow === true
    ),
    rateLimit
  );
}
