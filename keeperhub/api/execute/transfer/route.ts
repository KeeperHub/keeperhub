import "server-only";

import { NextResponse } from "next/server";
import { transferFundsCore } from "@/keeperhub/plugins/web3/steps/transfer-funds-core";
import { transferTokenCore } from "@/keeperhub/plugins/web3/steps/transfer-token-core";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  createExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { checkSpendingCap } from "../_lib/spending-cap";
import { validateTokenFields, validateTransferInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Auth
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit
  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  // 3. Parse body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 4. Validate input
  const validation = validateTransferInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const tokenValidation = validateTokenFields(body);
  if (!tokenValidation.valid) {
    return NextResponse.json(tokenValidation.error, { status: 400 });
  }

  const { network, recipientAddress, amount } = body as {
    network: string;
    recipientAddress: string;
    amount: string;
  };

  const isTokenTransfer = "tokenAddress" in body || "tokenConfig" in body;

  // 5. Wallet check
  const walletError = await requireWallet(apiKeyCtx.organizationId);
  if (walletError) {
    return walletError;
  }

  // 6. Spending cap
  const spendCap = await checkSpendingCap(apiKeyCtx.organizationId);
  if (!spendCap.allowed) {
    return NextResponse.json({ error: spendCap.reason }, { status: 403 });
  }

  // 6. Create execution record
  const redactedInput = redactInput(body);
  const { executionId } = await createExecution({
    organizationId: apiKeyCtx.organizationId,
    apiKeyId: apiKeyCtx.apiKeyId,
    type: "transfer",
    network,
    input: redactedInput,
  });

  // 7. Mark running
  await markRunning(executionId);

  // 8. Execute
  const context = { organizationId: apiKeyCtx.organizationId };

  const result = isTokenTransfer
    ? await transferTokenCore({
        network,
        tokenConfig: (body.tokenConfig ?? "") as
          | string
          | Record<string, unknown>,
        tokenAddress: body.tokenAddress as string | undefined,
        recipientAddress,
        amount,
        _context: context,
      })
    : await transferFundsCore({
        network,
        recipientAddress,
        amount,
        _context: context,
      });

  // 9. Handle result
  if (result.success) {
    await completeExecution(executionId, {
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      gasUsedWei: result.gasUsed,
      output: result as unknown as Record<string, unknown>,
    });
  } else {
    await failExecution(executionId, result.error);
  }

  // 10. Return
  return NextResponse.json(
    { executionId, status: result.success ? "completed" : "failed" },
    { status: 202 }
  );
}
