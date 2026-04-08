import "server-only";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi-cache";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import type { ConditionInput, ConditionResult } from "../_lib/condition";
import { evaluateCondition } from "../_lib/condition";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
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
    return NextResponse.json({ error: readResult.error }, { status: 400 });
  }

  return NextResponse.json(
    { executed: true, conditionResult, result: readResult.result },
    { status: 200 }
  );
}

async function executeConditionalWrite(
  action: ActionBody,
  network: string,
  resolvedWriteAbi: string,
  organizationId: string,
  apiKeyId: string,
  fullBody: Record<string, unknown>,
  conditionResult: ConditionResult
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }

  const redactedInput = redactInput(fullBody);
  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "check-and-execute",
    network,
    input: redactedInput,
  });
  if (!reserve.allowed) {
    return NextResponse.json({ error: reserve.reason }, { status: 403 });
  }
  const { executionId } = reserve;

  await markRunning(executionId);

  const result = await writeContractCore({
    contractAddress: action.contractAddress,
    network,
    abi: resolvedWriteAbi,
    abiFunction: action.functionName,
    functionArgs: action.functionArgs,
    gasLimitMultiplier: action.gasLimitMultiplier,
    _context: { organizationId },
  });

  if (result.success) {
    await completeExecution(executionId, {
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      gasUsedWei: result.gasUsed,
      gasPriceWei: result.effectiveGasPrice,
      output: result as unknown as Record<string, unknown>,
    });
  } else {
    await failExecution(executionId, result.error);
  }

  return NextResponse.json(
    {
      executionId,
      status: result.success ? "completed" : "failed",
      executed: true,
      conditionResult,
    },
    { status: 202 }
  );
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateCheckAndExecuteInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const network = body.network as string;
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
      { status: 400 }
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
    return NextResponse.json({ error: readResult.error }, { status: 400 });
  }

  const conditionResult = evaluateCondition(readResult.result, condition);

  if (!conditionResult.met) {
    return NextResponse.json(
      { executed: false, conditionResult },
      { status: 200 }
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
      { status: 400 }
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
      { status: 400 }
    );
  }

  const isReadOnly =
    actionFn.stateMutability === "view" || actionFn.stateMutability === "pure";

  if (isReadOnly) {
    return executeConditionalRead(
      action,
      network,
      writeAbiResult.abi,
      apiKeyCtx.organizationId,
      conditionResult
    );
  }

  return executeConditionalWrite(
    action,
    network,
    writeAbiResult.abi,
    apiKeyCtx.organizationId,
    apiKeyCtx.apiKeyId,
    body,
    conditionResult
  );
}
