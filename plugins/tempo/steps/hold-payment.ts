import "server-only";

import { ethers } from "ethers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { assertTempoChain } from "./tempo-step-helpers";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  type BroadcastMode,
  executeHoldPayment,
  type HoldPaymentCoreResult,
} from "./hold-payment-core";

export type HoldPaymentInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  broadcastMode?: BroadcastMode;
  broadcastAt?: string;
  validBefore?: string;
};

export type HoldPaymentResult = HoldPaymentCoreResult;

async function stepHandler(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  const missingRequiredField =
    !input.network ||
    input.tokenConfig == null ||
    input.recipientAddress == null ||
    input.amount == null;

  if (missingRequiredField) {
    return {
      success: false,
      error:
        "network, tokenConfig, amount, and recipientAddress are required",
      failureKind: "validation",
    };
  }

  try {
    const chainId = getChainIdFromNetwork(input.network);
    assertTempoChain(chainId);
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
      failureKind: "validation",
    };
  }

  if (!ethers.isAddress(input.recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${input.recipientAddress}`,
      failureKind: "validation",
    };
  }

  if (!input.amount || input.amount.trim() === "") {
    return {
      success: false,
      error: "Amount is required",
      failureKind: "validation",
    };
  }

  const { _context } = input;

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
      failureKind: "validation",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Hold Payment]",
    "hold-payment"
  );
  if (!orgCtx.success) {
    return {
      success: false,
      error: orgCtx.error,
      failureKind: "validation",
    };
  }

  return executeHoldPayment({
    organizationId: orgCtx.organizationId,
    userId: orgCtx.userId,
    network: input.network,
    tokenConfig: input.tokenConfig,
    amount: input.amount,
    recipientAddress: input.recipientAddress,
    memo: input.memo,
    broadcastMode: input.broadcastMode,
    broadcastAt: input.broadcastAt,
    validBefore: input.validBefore,
    workflowId: _context?.workflowId,
    executionId: _context?.executionId,
  });
}

export async function holdPaymentStep(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  "use step";

  return runPluginStep(
    { pluginName: "tempo", actionName: "hold-payment" },
    input,
    stepHandler
  );
}

holdPaymentStep.maxRetries = 0;

export const _integrationType = "tempo";
