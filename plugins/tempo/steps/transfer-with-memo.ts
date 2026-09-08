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
} from "./tempo-tx-core";
import {
  assertTempoChain,
  buildTempoTxLink,
  parseTimestamp,
  resolveTempoToken,
} from "./tempo-step-helpers";

// Optional native on-chain expiry: when set, the transfer can no longer settle
// after this instant. A window closing inside this buffer is rejected up front,
// since it could lapse before the tx is signed and included.
const MIN_INCLUSION_BUFFER_SEC = 60;

export type TransferWithMemoInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  validBefore?: string;
};

export type TransferWithMemoResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      from: string;
      to: string;
      amount: string;
      memo: string;
      validBefore: number | null;
      chainId: number;
    }
  | { success: false; error: string };

async function stepHandler(
  input: TransferWithMemoInput
): Promise<TransferWithMemoResult> {
  const { network, tokenConfig, amount, recipientAddress, memo, _context } =
    input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    assertTempoChain(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let validBeforeSec: number | undefined;
  try {
    validBeforeSec = parseTimestamp(input.validBefore, nowSec);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  if (
    validBeforeSec !== undefined &&
    validBeforeSec < nowSec + MIN_INCLUSION_BUFFER_SEC
  ) {
    return {
      success: false,
      error:
        "The expiry is too soon: 'expire if not settled by' must be at least 60 seconds ahead so the transfer can settle before it lapses.",
    };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Transfer]",
    "transfer-with-memo"
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
    const amountRaw = ethers.parseUnits(amount, token.decimals);
    const recipient = ethers.getAddress(recipientAddress) as Hex;
    const memoBytes = normalizeMemo(memo);

    const call = buildTransferWithMemoCall(
      token.address,
      recipient,
      amountRaw,
      memoBytes
    );
    const { hash, from } = await signAndBroadcastTempoTx({
      organizationId: orgCtx.organizationId,
      userId: orgCtx.userId,
      chainId,
      calls: [call],
      feeToken: token.address,
      validBefore: validBeforeSec,
      executionId: _context?.executionId,
    });

    const transactionLink = await buildTempoTxLink(chainId, hash);
    return {
      success: true,
      transactionHash: hash,
      transactionLink,
      from,
      to: recipient,
      amount,
      memo: memoBytes,
      validBefore: validBeforeSec ?? null,
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Transfer] transfer-with-memo failed",
      error,
      { plugin_name: "tempo", action_name: "transfer-with-memo" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function transferWithMemoStep(
  input: TransferWithMemoInput
): Promise<TransferWithMemoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "tempo", actionName: "transfer-with-memo" },
    input,
    stepHandler
  );
}

transferWithMemoStep.maxRetries = 0;

export const _integrationType = "tempo";
