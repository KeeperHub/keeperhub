import { HttpStatus } from "@/lib/http-status";
import "server-only";
import "@/protocols";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi/cache";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import {
  beginIdempotentFromRequest,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { getProtocol, resolveContractAddress } from "@/lib/protocol-registry";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { PLUGIN_STEP_IMPORTERS } from "@/lib/step-registry";
import { resolveProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";
import {
  type ReadContractCoreInput,
  readContractCore,
} from "@/plugins/web3/steps/read-contract-core";
import {
  type WriteContractCoreInput,
  writeContractCore,
} from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import { enforceDirectExecutionConcurrency } from "../_lib/concurrency-limit";
import {
  type CompleteExecutionOutcome,
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
  withRejectedSignerOverride,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { parseNativeValueWei } from "../_lib/reserved-value";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { requireWallet } from "../_lib/wallet-check";

function buildFunctionArgs(
  input: Record<string, unknown>,
  protocolSlug: string,
  contractKey: string,
  functionName: string
): string | undefined {
  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return undefined;
  }

  const protocolAction = protocol.actions.find(
    (a) => a.function === functionName && a.contract === contractKey
  );

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return undefined;
  }

  const args = protocolAction.inputs.map((inp) => {
    const value = input[inp.name];
    return value === undefined ? "" : String(value);
  });

  return JSON.stringify(args);
}

async function executeProtocolAction(
  actionType: string,
  body: Record<string, unknown>,
  organizationId: string,
  apiKeyId: string,
  idem: IdempotencyOutcome | null
): Promise<NextResponse> {
  const meta = resolveProtocolMeta({ _actionType: actionType });
  if (!meta) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error: `Could not resolve protocol metadata for: ${actionType}`,
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  const protocol = getProtocol(meta.protocolSlug);
  if (!protocol) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { success: false, error: `Unknown protocol: ${meta.protocolSlug}` },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  const contract = protocol.contracts[meta.contractKey];
  if (!contract) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error: `Unknown contract key "${meta.contractKey}" in protocol "${meta.protocolSlug}"`,
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  // KEEP-490: accept `chainId` as the canonical input, with `network` as a
  // deprecated alias. Either field may carry the numeric chain ID (1, 11155111)
  // or a known chain name/slug ("ethereum", "sepolia", "base"). Downstream
  // helpers (contract.addresses, resolveAbi, the chain adapter) are keyed by
  // numeric chainId, so normalize here once.
  const rawNetwork = String(body.chainId ?? body.network ?? "");
  if (!rawNetwork) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error:
            "Missing required field: chainId (or network, which is a deprecated alias)",
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  let resolvedChainId: number;
  try {
    resolvedChainId = getChainIdFromNetwork(rawNetwork);
  } catch (err: unknown) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }
  const network = String(resolvedChainId);

  const contractAddress = resolveContractAddress(
    contract,
    network,
    String(body.contractAddress ?? "")
  );

  if (!contractAddress) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error: contract.userSpecifiedAddress
            ? `Missing contract address for "${meta.contractKey}"`
            : `Protocol "${meta.protocolSlug}" contract "${meta.contractKey}" is not deployed on chain ${network} (input: "${rawNetwork}")`,
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  let resolvedAbi: string;
  try {
    const abiResult = await resolveAbi({
      contractAddress,
      network,
      abi: contract.abi,
    });
    resolvedAbi = abiResult.abi;
  } catch (err: unknown) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          success: false,
          error: `Failed to resolve ABI: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: HttpStatus.BAD_REQUEST }
      )
    );
  }

  const functionArgs = buildFunctionArgs(
    body,
    meta.protocolSlug,
    meta.contractKey,
    meta.functionName
  );

  if (meta.actionType === "read") {
    const coreInput: ReadContractCoreInput = {
      contractAddress,
      network,
      abi: resolvedAbi,
      abiFunction: meta.functionName,
      functionArgs,
      _context: { organizationId },
    };
    const result = await readContractCore(coreInput);
    return recordIdempotentResponse(idem, NextResponse.json(result));
  }

  // KEEP-793 / A-07: protocol write actions sign and broadcast a real tx from
  // the org wallet, so they must clear the same gates as every other direct
  // write path (transfer, contract-call, check-and-execute): plan execution
  // limit, wallet presence, daily spend cap, and a recorded directExecutions
  // audit row. Reads above stay ungated. Each gate fails before any broadcast,
  // so it releases the idempotency lock for a clean retry instead of finalizing
  // the error against the key.
  const executionGuard = await enforceExecutionLimit(organizationId);
  if (executionGuard.blocked) {
    return recordIdempotentResponse(idem, executionGuard.response, "release");
  }

  const concurrency = await enforceDirectExecutionConcurrency(organizationId);
  if (concurrency) {
    return recordIdempotentResponse(idem, concurrency, "release");
  }

  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return recordIdempotentResponse(idem, walletError, "release");
  }

  const ethValue = body.ethValue ? String(body.ethValue) : undefined;
  // Charge any native value forwarded by the protocol write against the cap.
  const parsedValue = parseNativeValueWei(ethValue);
  if (!parsedValue.ok) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { success: false, error: parsedValue.error },
        { status: HttpStatus.BAD_REQUEST }
      ),
      "release"
    );
  }

  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "protocol-action",
    network,
    input: redactInput(withRejectedSignerOverride(body, body)),
    reserved: { kind: "evm", valueWei: parsedValue.valueWei },
  });
  if (!reserve.allowed) {
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { success: false, error: reserve.reason },
        { status: HttpStatus.FORBIDDEN }
      ),
      "release"
    );
  }
  const { executionId } = reserve;
  await markRunning(executionId);

  const coreInput: WriteContractCoreInput = {
    contractAddress,
    network,
    abi: resolvedAbi,
    abiFunction: meta.functionName,
    functionArgs,
    ethValue,
    _context: { organizationId },
  };
  const result = await withIdempotencyHeartbeat(idem, () =>
    writeContractCore(coreInput)
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

  const responseBody =
    outcome.status === "completed"
      ? result
      : { ...result, success: false, error: outcome.error };

  // The tx reached the broadcast path, so finalize as success or failed and
  // never release: a retry on the same key must not re-broadcast.
  return recordIdempotentResponse(
    idem,
    NextResponse.json(responseBody),
    outcome.status === "completed" ? "success" : "failed"
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const actionType = slug.join("/");

  if (slug.length < 2) {
    return NextResponse.json(
      { error: `Invalid action type: ${actionType}` },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // Verify the action exists in the registry
  if (!PLUGIN_STEP_IMPORTERS[actionType]) {
    return NextResponse.json(
      { error: `Unknown action: ${actionType}` },
      { status: HttpStatus.NOT_FOUND }
    );
  }

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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: `execute:${actionType}`,
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

  try {
    // Try protocol action first (covers all protocol read/write tools)
    const meta = resolveProtocolMeta({ _actionType: actionType });
    if (meta) {
      const response = await executeProtocolAction(
        actionType,
        body,
        apiKeyCtx.organizationId,
        apiKeyCtx.apiKeyId,
        idem
      );
      return applyRateLimitHeaders(response, rateLimit);
    }

    // Non-protocol actions are not yet supported via direct execution. This
    // never broadcasts, so release the lock for a clean retry.
    return applyRateLimitHeaders(
      await recordIdempotentResponse(
        idem,
        NextResponse.json(
          {
            error: `Direct execution not supported for "${actionType}". Use workflow execution instead.`,
            hint: "Create a workflow with this action and execute it via workflow_execute.",
          },
          { status: HttpStatus.NOT_IMPLEMENTED }
        ),
        "release"
      ),
      rateLimit
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // A thrown error may have left a tx mid-broadcast: finalize as failed so a
    // retry replays the failure instead of re-broadcasting.
    return applyRateLimitHeaders(
      await recordIdempotentResponse(
        idem,
        NextResponse.json(
          { success: false, error: message },
          { status: HttpStatus.INTERNAL_SERVER_ERROR }
        ),
        "failed"
      ),
      rateLimit
    );
  }
}
