import "server-only";

import { ethers } from "ethers";
import type { Hex } from "viem";
import { createHeldPayment } from "@/lib/tempo/held-payments";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import {
  buildTransferWithMemoCall,
  normalizeMemo,
  signTempoTx,
} from "./tempo-tx-core";
import {
  assertTempoChain,
  parseTimestamp,
  resolveTempoToken,
} from "./tempo-step-helpers";

const DEFAULT_MANUAL_WINDOW_SEC = 24 * 60 * 60;
const DEFAULT_SCHEDULE_SLACK_SEC = 60 * 60;
const MIN_WINDOW_BUFFER_SEC = 60;
const HELD_PAYMENT_FEE_MULTIPLIER = 4;
const HELD_PAYMENT_MAX_FEE_FLOOR_WEI = BigInt(50_000_000_000);

export type BroadcastMode = "manual" | "schedule";

export type HoldPaymentCoreInput = {
  organizationId: string;
  userId?: string;
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  broadcastMode?: BroadcastMode;
  broadcastAt?: string;
  validBefore?: string;
  workflowId?: string;
  executionId?: string;
};

export type HoldPaymentFailureKind = "validation" | "infrastructure";

export type HoldPaymentCoreResult =
  | {
      success: true;
      paymentId: string;
      precomputedHash: string;
      from: string;
      to: string;
      amount: string;
      memo: string;
      broadcastMode: BroadcastMode;
      broadcastAt: string | null;
      validBefore: number;
      status: "pending";
      chainId: number;
    }
  | {
      success: false;
      error: string;
      failureKind: HoldPaymentFailureKind;
    };

type ResolvedWindow =
  | { ok: true; broadcastAt: Date | null; validBeforeSec: number }
  | { ok: false; error: string };

function validationFailure(error: string): HoldPaymentCoreResult {
  return { success: false, error, failureKind: "validation" };
}

function infrastructureFailure(error: string): HoldPaymentCoreResult {
  return { success: false, error, failureKind: "infrastructure" };
}

function resolveWindow(
  mode: BroadcastMode,
  broadcastAtRaw: string | undefined,
  validBeforeRaw: string | undefined,
  nowSec: number
): ResolvedWindow {
  let broadcastAtSec: number | undefined;
  try {
    broadcastAtSec = parseTimestamp(broadcastAtRaw, nowSec);
    const parsedValidBefore = parseTimestamp(validBeforeRaw, nowSec);
    if (mode === "schedule") {
      if (broadcastAtSec === undefined) {
        return {
          ok: false,
          error: "broadcastAt is required when broadcastMode is 'schedule'.",
        };
      }
      if (broadcastAtSec <= nowSec) {
        return {
          ok: false,
          error: "broadcastAt must be in the future for a scheduled hold.",
        };
      }
      const validBeforeSec =
        parsedValidBefore ?? broadcastAtSec + DEFAULT_SCHEDULE_SLACK_SEC;
      if (validBeforeSec <= broadcastAtSec) {
        return {
          ok: false,
          error: "validBefore must be after the scheduled broadcast time.",
        };
      }
      return {
        ok: true,
        broadcastAt: new Date(broadcastAtSec * 1000),
        validBeforeSec,
      };
    }
    const validBeforeSec =
      parsedValidBefore ?? nowSec + DEFAULT_MANUAL_WINDOW_SEC;
    if (validBeforeSec < nowSec + MIN_WINDOW_BUFFER_SEC) {
      return {
        ok: false,
        error:
          "The payment window closes too soon: validBefore must be at least 60 seconds ahead so the held payment can be broadcast before it lapses.",
      };
    }
    return { ok: true, broadcastAt: null, validBeforeSec };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

export async function executeHoldPayment(
  input: HoldPaymentCoreInput
): Promise<HoldPaymentCoreResult> {
  const broadcastMode: BroadcastMode =
    input.broadcastMode === "schedule" ? "schedule" : "manual";

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
    assertTempoChain(chainId);
  } catch (error) {
    return validationFailure(getErrorMessage(error));
  }

  if (!ethers.isAddress(input.recipientAddress)) {
    return validationFailure(
      `Invalid recipient address: ${input.recipientAddress}`
    );
  }
  if (!input.amount || input.amount.trim() === "") {
    return validationFailure("Amount is required");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const window = resolveWindow(
    broadcastMode,
    input.broadcastAt,
    input.validBefore,
    nowSec
  );
  if (!window.ok) {
    return validationFailure(window.error);
  }

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({
      chainId,
      userId: input.userId,
    });
  } catch (error) {
    return infrastructureFailure(getErrorMessage(error));
  }

  let token: Awaited<ReturnType<typeof resolveTempoToken>>;
  let amountRaw: bigint;
  try {
    token = await resolveTempoToken(
      input.tokenConfig,
      chainId,
      rpcManager
    );
    amountRaw = ethers.parseUnits(input.amount, token.decimals);
  } catch (error) {
    return validationFailure(getErrorMessage(error));
  }

  const recipient = ethers.getAddress(input.recipientAddress) as Hex;
  let memoBytes: ReturnType<typeof normalizeMemo>;
  try {
    memoBytes = normalizeMemo(input.memo);
  } catch (error) {
    return validationFailure(getErrorMessage(error));
  }

  try {

    const call = buildTransferWithMemoCall(
      token.address,
      recipient,
      amountRaw,
      memoBytes
    );
    const signed = await signTempoTx({
      organizationId: input.organizationId,
      userId: input.userId,
      chainId,
      calls: [call],
      feeToken: token.address,
      validBefore: window.validBeforeSec,
      executionId: input.executionId,
      maxFeePerGasMultiplier: HELD_PAYMENT_FEE_MULTIPLIER,
      maxFeePerGasFloor: HELD_PAYMENT_MAX_FEE_FLOOR_WEI,
    });

    const held = await createHeldPayment({
      organizationId: input.organizationId,
      createdByUserId: input.userId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      chainId,
      fromAddress: signed.from,
      toAddress: recipient,
      tokenAddress: token.address,
      amountRaw: amountRaw.toString(),
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amountDisplay: input.amount,
      memo: input.memo?.trim() ? input.memo.trim() : undefined,
      serializedTx: signed.serialized,
      precomputedHash: signed.hash,
      nonceKey: signed.nonceKey.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      validBefore: window.validBeforeSec,
      broadcastAt: window.broadcastAt,
    });

    return {
      success: true,
      paymentId: held.id,
      precomputedHash: signed.hash,
      from: signed.from,
      to: recipient,
      amount: input.amount,
      memo: memoBytes,
      broadcastMode,
      broadcastAt: window.broadcastAt ? window.broadcastAt.toISOString() : null,
      validBefore: window.validBeforeSec,
      status: "pending",
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Hold Payment] hold-payment failed",
      error,
      { plugin_name: "tempo", action_name: "hold-payment" }
    );
    return infrastructureFailure(getErrorMessage(error));
  }
}
