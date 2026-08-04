import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { NextResponse } from "next/server";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import {
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { transferFundsCore } from "@/plugins/web3/steps/transfer-funds-core";
import { transferTokenCore } from "@/plugins/web3/steps/transfer-token-core";
import { validateApiKey } from "../_lib/auth";
import { enforceDirectExecutionConcurrency } from "../_lib/concurrency-limit";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
  withRejectedSignerOverride,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import {
  isSolanaNetwork,
  parseNativeValueLamports,
  parseNativeValueWei,
} from "../_lib/reserved-value";
import { parseSimulateFlag } from "../_lib/simulate-flag";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import type { ExecuteResponse } from "../_lib/types";
import { validateTokenFields, validateTransferInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Auth
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

  // 2. Rate limit
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

  // 2.5 Plan execution-limit guard
  const executionGuard = await enforceExecutionLimit(apiKeyCtx.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  // 3. Parse body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // 4. Validate input
  const validation = validateTransferInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, {
      status: HttpStatus.BAD_REQUEST,
    });
  }

  const tokenValidation = validateTokenFields(body);
  if (!tokenValidation.valid) {
    return NextResponse.json(tokenValidation.error, {
      status: HttpStatus.BAD_REQUEST,
    });
  }

  // KEEP-490: accept `chainId` as canonical, `network` as deprecated alias.
  // The core helper normalizes the value internally (chainId number / string,
  // or a known chain name) so we just pick whichever field is present.
  const network = String(
    (body as Record<string, unknown>).chainId ?? body.network ?? ""
  );
  const { recipientAddress, amount } = body as {
    recipientAddress: string;
    amount: string;
  };

  const isTokenTransfer = "tokenAddress" in body || "tokenConfig" in body;

  // 5. Wallet check
  const walletError = await requireWallet(apiKeyCtx.organizationId);
  if (walletError) {
    return walletError;
  }

  // 5.5 Dry-run path: validate inputs, simulate via estimateGas only,
  // never broadcast, never reserve. Triggered by strict boolean
  // `simulate: true` on the body. Token-transfer simulates resolve the
  // token address via the same parseTokenAddress helper the broadcast
  // path uses and fetch on-chain decimals when not provided.
  const simulateFlag = parseSimulateFlag(body);
  if (!simulateFlag.ok) {
    return NextResponse.json(
      { error: simulateFlag.error, field: "simulate" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }
  if (simulateFlag.simulate) {
    if (isTokenTransfer) {
      const result = await simulateTokenTransfer({
        organizationId: apiKeyCtx.organizationId,
        network,
        tokenAddress: body.tokenAddress as string | undefined,
        tokenConfig: body.tokenConfig as
          | string
          | Record<string, unknown>
          | undefined,
        recipientAddress,
        amount,
        decimals: typeof body.decimals === "number" ? body.decimals : undefined,
      });
      return NextResponse.json(result, {
        status: result.wouldRevert ? HttpStatus.BAD_REQUEST : HttpStatus.OK,
      });
    }
    const nativeResult = await simulateNativeTransfer({
      organizationId: apiKeyCtx.organizationId,
      network,
      recipientAddress,
      amount,
    });
    return NextResponse.json(nativeResult, {
      status: nativeResult.wouldRevert ? HttpStatus.BAD_REQUEST : HttpStatus.OK,
    });
  }

  // 5.55 Concurrency back-pressure: gate the state-changing write path only
  // (reads/simulations/replays are not throttled). Checked before reserving the
  // idempotency key so a 429 leaves no key to release.
  const concurrency = await enforceDirectExecutionConcurrency(
    apiKeyCtx.organizationId
  );
  if (concurrency) {
    return concurrency;
  }

  // 5.6 Idempotency: an Idempotency-Key lets clients retry a broadcast safely.
  // Reserve the key (per-org, across direct-execution endpoints) before doing
  // any state-changing work; a replay/conflict/in-progress short-circuits here.
  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: "execute:transfer",
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

  // 6. Spending cap + create execution atomically. Native transfers charge
  // their value against the daily cap for the chain family: this route serves
  // Solana too (transferFundsCore branches on a Solana chainId), so a SOL
  // transfer is parsed at 9 decimals and charged to the lamports cap rather
  // than being scaled to 18 and charged to the ETH-denominated one. Token
  // transfers move no native value (token value is not yet priced into the
  // cap) so reserve 0.
  const redactedInput = redactInput(withRejectedSignerOverride(body, body));
  const isSolanaTransfer = isSolanaNetwork(network);
  let reservedValueWei = "0";
  let reservedValueLamports = "0";
  if (!isTokenTransfer) {
    const parsedValue = isSolanaTransfer
      ? parseNativeValueLamports(amount)
      : parseNativeValueWei(amount);
    if (!parsedValue.ok) {
      return applyRateLimitHeaders(
        await recordIdempotentResponse(
          idem,
          NextResponse.json(
            { error: parsedValue.error, field: "amount" },
            { status: HttpStatus.BAD_REQUEST }
          ),
          "release"
        ),
        rateLimit
      );
    }
    if (isSolanaTransfer) {
      reservedValueLamports = parsedValue.valueWei;
    } else {
      reservedValueWei = parsedValue.valueWei;
    }
  }
  const reserve = await checkAndReserveExecution({
    organizationId: apiKeyCtx.organizationId,
    apiKeyId: apiKeyCtx.apiKeyId,
    type: "transfer",
    network,
    input: redactedInput,
    reserved: isSolanaTransfer
      ? { kind: "solana", valueLamports: reservedValueLamports }
      : { kind: "evm", valueWei: reservedValueWei },
  });
  if (!reserve.allowed) {
    // Pre-broadcast gating failure: release so the same key can be retried.
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
  const { executionId } = reserve;

  // 7. Mark running
  await markRunning(executionId);

  // 8. Execute (heartbeat the idempotency lock across the on-chain wait).
  const context = { organizationId: apiKeyCtx.organizationId };

  const result = await withIdempotencyHeartbeat(idem, () =>
    isTokenTransfer
      ? transferTokenCore({
          network,
          tokenConfig: (body.tokenConfig ?? "") as
            | string
            | Record<string, unknown>,
          tokenAddress: body.tokenAddress as string | undefined,
          recipientAddress,
          amount,
          _context: context,
        })
      : transferFundsCore({
          network,
          recipientAddress,
          amount,
          _context: context,
        })
  );

  // 9. Handle result. completeExecution independently re-verifies the claimed
  // transaction against the chain (KEEP-966) -- its returned outcome, not
  // result.success, is authoritative for the response and idempotency cache.
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

  // 10. Return. A failed broadcast/verification is finalized (not released)
  // so a retry replays the failure instead of re-sending the tx. status/error
  // come from the verified `outcome` (KEEP-966), not the self-reported
  // result.success -- transactionHash/transactionLink are included whenever a
  // tx was actually broadcast (result.success), regardless of final outcome,
  // so a reconciliation-failed response still surfaces the hash to look up.
  const responseBody: ExecuteResponse = {
    executionId,
    status: outcome.status,
    ...(result.success
      ? {
          transactionHash: result.transactionHash,
          transactionLink: result.transactionLink,
        }
      : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  return applyRateLimitHeaders(
    await recordIdempotentResponse(
      idem,
      NextResponse.json(responseBody, { status: HttpStatus.ACCEPTED }),
      outcome.status === "completed" ? "success" : "failed"
    ),
    rateLimit
  );
}
