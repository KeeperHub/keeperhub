import "server-only";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi-cache";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { validateContractCallInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

type AbiEntry = {
  type: string;
  name?: string;
  stateMutability?: string;
};

function findFunctionInAbi(
  abi: string,
  functionName: string
): { entry: AbiEntry } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi);
  } catch {
    return { error: "Invalid ABI JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { error: "ABI must be a JSON array" };
  }

  const entry = parsed.find(
    (item: AbiEntry) => item.type === "function" && item.name === functionName
  ) as AbiEntry | undefined;

  if (!entry) {
    return { error: `Function '${functionName}' not found in ABI` };
  }

  return { entry };
}

async function resolveAbiForRequest(
  body: Record<string, unknown>
): Promise<{ abi: string } | { error: string }> {
  if (typeof body.abi === "string" && body.abi.trim() !== "") {
    return { abi: body.abi };
  }

  try {
    const resolved = await resolveAbi({
      contractAddress: body.contractAddress as string,
      network: body.network as string,
    });
    return { abi: resolved.abi };
  } catch (err: unknown) {
    return {
      error: `ABI is required. Could not auto-fetch ABI: ${getErrorMessage(err)}`,
    };
  }
}

async function handleReadCall(
  body: Record<string, unknown>,
  resolvedAbi: string,
  organizationId: string
): Promise<NextResponse> {
  const result = await readContractCore({
    contractAddress: body.contractAddress as string,
    network: body.network as string,
    abi: resolvedAbi,
    abiFunction: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    _context: { organizationId },
  });

  if (result.success) {
    return NextResponse.json({ result: result.result }, { status: 200 });
  }

  return NextResponse.json({ error: result.error }, { status: 400 });
}

async function handleWriteCall(
  body: Record<string, unknown>,
  resolvedAbi: string,
  organizationId: string,
  apiKeyId: string
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }

  const redactedInput = redactInput(body);
  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "contract-call",
    network: body.network as string,
    input: redactedInput,
  });
  if (!reserve.allowed) {
    return NextResponse.json({ error: reserve.reason }, { status: 403 });
  }
  const { executionId } = reserve;

  await markRunning(executionId);

  const result = await writeContractCore({
    contractAddress: body.contractAddress as string,
    network: body.network as string,
    abi: resolvedAbi,
    abiFunction: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    ethValue: body.ethValue as string | undefined,
    gasLimitMultiplier: body.gasLimitMultiplier as string | undefined,
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
    { executionId, status: result.success ? "completed" : "failed" },
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

  const validation = validateContractCallInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const abiResult = await resolveAbiForRequest(body);
  if ("error" in abiResult) {
    return NextResponse.json(
      { error: abiResult.error, field: "abi" },
      { status: 400 }
    );
  }

  const resolvedAbi = abiResult.abi;

  const fnResult = findFunctionInAbi(resolvedAbi, body.functionName as string);
  if ("error" in fnResult) {
    return NextResponse.json(
      { error: fnResult.error, field: "functionName" },
      { status: 400 }
    );
  }

  const isReadOnly =
    fnResult.entry.stateMutability === "view" ||
    fnResult.entry.stateMutability === "pure";

  if (isReadOnly) {
    return handleReadCall(body, resolvedAbi, apiKeyCtx.organizationId);
  }

  return handleWriteCall(
    body,
    resolvedAbi,
    apiKeyCtx.organizationId,
    apiKeyCtx.apiKeyId
  );
}
