import "server-only";

import { ethers } from "ethers";
import type { Hex } from "viem";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  buildTransferWithMemoCall,
  normalizeMemo,
  signAndBroadcastTempoTx,
  type TempoCall,
} from "./tempo-tx-core";
import {
  assertTempoChain,
  buildTempoTxLink,
  resolveTempoToken,
  type TempoToken,
} from "./tempo-step-helpers";

// One atomic transaction batches many payouts; cap the count so a runaway
// list cannot blow past the block gas limit. Comfortably above the
// monthly-payroll cadence these flows target.
const MAX_PAYOUTS = 50;

export type BatchPayoutInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  payouts: string | unknown[];
  memo?: string;
};

type PayoutEntry = { recipient: string; amount: string; memo?: string };

export type BatchPayoutResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      from: string;
      payoutCount: number;
      totalAmount: string;
      chainId: number;
    }
  | { success: false; error: string };

function coerceAmount(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function parsePayouts(raw: string | unknown[]): PayoutEntry[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        "Payouts must be a JSON array of { recipient, amount, memo? }"
      );
    }
  }
  if (!Array.isArray(value)) {
    throw new Error("Payouts must be a JSON array");
  }
  if (value.length === 0) {
    throw new Error("Payouts is empty");
  }
  if (value.length > MAX_PAYOUTS) {
    throw new Error(
      `Too many payouts: ${value.length} exceeds the ${MAX_PAYOUTS} per-batch limit`
    );
  }
  return value.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const recipient = typeof record.recipient === "string" ? record.recipient : "";
    const amount = coerceAmount(record.amount);
    const memo = typeof record.memo === "string" ? record.memo : undefined;
    if (!ethers.isAddress(recipient)) {
      throw new Error(
        `Payout ${index + 1}: invalid recipient address "${recipient}"`
      );
    }
    if (amount.trim() === "") {
      throw new Error(`Payout ${index + 1}: amount is required`);
    }
    return { recipient, amount, memo };
  });
}

// All payouts move the same token, so the batch has a single fee token. Each
// call carries its own memo, falling back to the shared memo when unset.
function buildPayoutCalls(
  payouts: PayoutEntry[],
  token: TempoToken,
  sharedMemo?: string
): { calls: TempoCall[]; total: bigint } {
  const calls: TempoCall[] = [];
  let total = BigInt(0);
  for (const payout of payouts) {
    const amountRaw = ethers.parseUnits(payout.amount, token.decimals);
    if (amountRaw <= BigInt(0)) {
      throw new Error(
        `Payout to ${payout.recipient}: amount must be greater than zero`
      );
    }
    total += amountRaw;
    const memoBytes = normalizeMemo(payout.memo ?? sharedMemo);
    calls.push(
      buildTransferWithMemoCall(
        token.address,
        ethers.getAddress(payout.recipient) as Hex,
        amountRaw,
        memoBytes
      )
    );
  }
  return { calls, total };
}

async function stepHandler(input: BatchPayoutInput): Promise<BatchPayoutResult> {
  const { network, tokenConfig, payouts, memo, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    assertTempoChain(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Batch Payout]",
    "batch-payout"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  try {
    const rpcManager = await getRpcProvider({
      chainId,
      userId: orgCtx.userId,
    });
    const token = await resolveTempoToken(tokenConfig, chainId, rpcManager);
    const entries = parsePayouts(payouts);
    const { calls, total } = buildPayoutCalls(entries, token, memo);

    const { hash, from } = await signAndBroadcastTempoTx({
      organizationId: orgCtx.organizationId,
      userId: orgCtx.userId,
      chainId,
      calls,
      feeToken: token.address,
      executionId: _context?.executionId,
    });

    const transactionLink = await buildTempoTxLink(chainId, hash);
    return {
      success: true,
      transactionHash: hash,
      transactionLink,
      from,
      payoutCount: calls.length,
      totalAmount: ethers.formatUnits(total, token.decimals),
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Batch Payout] batch-payout failed",
      error,
      { plugin_name: "tempo", action_name: "batch-payout" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function batchPayoutStep(
  input: BatchPayoutInput
): Promise<BatchPayoutResult> {
  "use step";

  return runPluginStep(
    { pluginName: "tempo", actionName: "batch-payout" },
    input,
    stepHandler
  );
}

batchPayoutStep.maxRetries = 0;

export const _integrationType = "tempo";
