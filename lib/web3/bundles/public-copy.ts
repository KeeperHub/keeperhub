import "server-only";

import { ethers, isError } from "ethers";
import { ErrorCategory, logSystemError, logWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { minBlockGapSeconds } from "@/lib/web3/beacon-slots";
import { simulateSendAtNextBlock } from "@/lib/web3/next-block-simulation";
import { getNonceManager } from "@/lib/web3/nonce-manager";
import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  isPreBroadcastNetworkError,
  submitRawSignedWithFailover,
} from "@/lib/web3/submit-signed";
import {
  type FallbackNotSentReason,
  PUBLIC_COPY_ERRORS,
} from "@/lib/workflow/executor/run-outcome-keys";
import type { MinedHash } from "./bundle-history";
import { beforeDeadline, pollMsOf, sleepFor, slotMsOf } from "./inclusion";
import { nextBaseFee } from "./plan";
import type {
  BundleSendInput,
  PublicCopyReport,
  Recorded,
} from "./send-bundle";

function logPublicCopy(message: string, error: unknown, chainId: number): void {
  logSystemError(ErrorCategory.DATABASE, `[Bundle] ${message}`, error, {
    plugin_name: "web3",
    action_name: "write-contract",
    chain_id: String(chainId),
  });
}

const LOST_RACE_CHECK_MS = 5000;

/** Whether the call reverts on the state after `mined`'s block: someone made it first. */
export async function lostRace(
  input: BundleSendInput,
  mined: MinedHash
): Promise<boolean> {
  if (mined.blockNumber === null) {
    return false;
  }
  const blockTag = mined.blockNumber;
  try {
    await beforeDeadline(
      input.rpcManager.executeWithFailover((provider) =>
        provider.call({ ...input.call, blockTag })
      ),
      Date.now() + LOST_RACE_CHECK_MS
    );
    return false;
  } catch (error) {
    return isError(error, "CALL_EXCEPTION");
  }
}

export type StillNeeded = "pass" | "no-longer-needed" | "unchecked";

/** The send check for the block after `head`, with the signed gas limit: a revert means no longer needed. */
export async function stillNeeded(
  input: BundleSendInput,
  recorded: Recorded,
  head: number,
  deadline: number
): Promise<StillNeeded> {
  try {
    await beforeDeadline(
      simulateSendAtNextBlock(input.rpcManager, {
        chainId: input.chainId,
        gasLimit: recorded.gasLimit,
        contractInterface: input.contractInterface,
        tx: input.call,
        options: { targetBlock: head + 1 },
      }),
      deadline
    );
    return "pass";
  } catch (error) {
    return isError(error, "CALL_EXCEPTION") ? "no-longer-needed" : "unchecked";
  }
}

/** The signed fee cap against the exact base fee of the block after latest. */
export async function feeCoversNextBlock(
  input: BundleSendInput,
  signedHex: string
): Promise<"covers" | "below" | "unreadable"> {
  const maxFee = ethers.Transaction.from(signedHex).maxFeePerGas;
  try {
    const latest = await input.rpcManager.executeWithFailover((provider) =>
      provider.getBlock("latest")
    );
    const baseFee = latest?.baseFeePerGas;
    if (
      !latest ||
      baseFee === null ||
      baseFee === undefined ||
      maxFee === null
    ) {
      return "unreadable";
    }
    const next = nextBaseFee({
      baseFee,
      gasUsed: latest.gasUsed,
      gasLimit: latest.gasLimit,
    });
    return maxFee >= next ? "covers" : "below";
  } catch {
    return "unreadable";
  }
}

type GateHead = { number: number; timestamp: number };

/**
 * Open when the head is at least the first target - 1 and, with Not before, the next slot is not before it.
 * Any block that can include a copy sent now is a slot later (a reorg sibling too): time holds, the number alone does not.
 */
export function publicGateOpen(
  head: GateHead,
  gate: { firstTarget: number; notBefore?: number; gapSeconds?: number }
): boolean {
  if (head.number < gate.firstTarget - 1) {
    return false;
  }
  if (gate.notBefore === undefined) {
    return true;
  }
  return (
    gate.gapSeconds !== undefined &&
    head.timestamp + gate.gapSeconds >= gate.notBefore
  );
}

/** Poll until the gate opens, stopping a slot before the window ends; the head then, else undefined. */
async function waitForPublicGate(
  input: BundleSendInput,
  recorded: Recorded,
  deadline: number
): Promise<GateHead | undefined> {
  const gate = {
    firstTarget: recorded.targets[0].block,
    ...(input.sendAhead && {
      notBefore: input.sendAhead.notBefore,
      gapSeconds: minBlockGapSeconds(input.chainId),
    }),
  };
  while (Date.now() < deadline) {
    try {
      const head = await beforeDeadline(
        input.rpcManager.executeWithFailover((provider) =>
          provider.getBlock("latest")
        ),
        deadline
      );
      if (head && publicGateOpen(head, gate)) {
        return { number: head.number, timestamp: head.timestamp };
      }
    } catch {
      // Unreadable: try again until the deadline.
    }
    await sleepFor(Math.min(pollMsOf(input), deadline - Date.now()));
  }
  return;
}

type PublicCopyResult =
  | { kind: "out" }
  | { kind: "not-sent"; reason: FallbackNotSentReason }
  // No public RPC could be reached: the row is a plain bundle row again.
  | { kind: "refused" }
  // The nonce was used before the copy went out: the row is a plain bundle row again.
  | { kind: "nonce-used" };

function hasRelayPrimary(rpcManager: RpcProviderManager): boolean {
  return (
    typeof rpcManager.hasPrivateRelayPrimary === "function" &&
    rpcManager.hasPrivateRelayPrimary()
  );
}

// Partial managers (tests) may not expose it; unknown counts as the platform's.
function sentVia(rpcManager: RpcProviderManager): "user" | "platform" {
  return typeof rpcManager.usesUserRpc === "function" &&
    rpcManager.usesUserRpc()
    ? "user"
    : "platform";
}

/**
 * Send one recorded signed transaction publicly: gate, send check (unless just run), record on the row, then
 * the raw send bounded a slot before the window's end. A timeout or unclear answer counts as out.
 */
export async function sendPublicCopy(
  input: BundleSendInput,
  recorded: Recorded,
  kind: "with-bundle" | "fallback",
  index: number,
  options: { checked?: boolean } = {}
): Promise<PublicCopyResult> {
  const signedHex = recorded.signed[index];
  const hash = ethers.keccak256(signedHex);
  const deadline = recorded.windowEnd - slotMsOf(input);
  const copyNotSent = (
    reason: FallbackNotSentReason,
    error: string
  ): PublicCopyResult => {
    recorded.report.publicCopy = { hash, accepted: false, error };
    return { kind: "not-sent", reason };
  };
  // Never public through a private relay, whatever the caller passed.
  if (hasRelayPrimary(input.rpcManager)) {
    return copyNotSent("no-public-rpc", PUBLIC_COPY_ERRORS.relay);
  }
  const head = await waitForPublicGate(input, recorded, deadline);
  if (!head) {
    return copyNotSent(
      "first-allowed-block-not-reached",
      PUBLIC_COPY_ERRORS.gate
    );
  }
  if (
    !options.checked &&
    (await stillNeeded(input, recorded, head.number, deadline)) ===
      "no-longer-needed"
  ) {
    return copyNotSent("no-longer-needed", PUBLIC_COPY_ERRORS.needed);
  }
  let marked = false;
  try {
    marked = await getNonceManager().markPublicCopy(
      input.session,
      recorded.nonce,
      { hash, kind, via: sentVia(input.rpcManager) }
    );
  } catch (error) {
    logPublicCopy("Could not record a public copy", error, input.chainId);
  }
  if (!marked) {
    return copyNotSent("not-recorded", PUBLIC_COPY_ERRORS.record);
  }
  const sent: PublicCopyReport = {
    hash,
    sentAtBlock: head.number,
    accepted: null,
  };
  recorded.report.publicCopy = sent;
  try {
    await beforeDeadline(
      submitRawSignedWithFailover(signedHex, input.rpcManager),
      deadline
    );
    sent.accepted = true;
  } catch (error) {
    const adapted = adaptPublicSendError(error);
    if (adapted !== "out") {
      return await publicCopyNotOut(input, recorded, adapted);
    }
    logWarn("[Bundle] Public copy send unclear; treated as out", {
      chain_id: String(input.chainId),
      tx_hash: hash,
      error: error instanceof Error ? error.name : "unknown",
      message: redactAllUrls(
        error instanceof Error ? error.message : String(error)
      ).slice(0, SEND_ERROR_MESSAGE_CHARS),
    });
  }
  recorded.publicHash = hash;
  return { kind: "out" };
}

// How much of an unclear send's error message the warning keeps.
const SEND_ERROR_MESSAGE_CHARS = 200;

// A node's definite rejection of the bytes: it never pooled them.
const NODE_REJECTION_RE =
  /insufficient funds|intrinsic gas too low|invalid sender/i;

/** Every endpoint definitely rejected it: no attempt may have sent it, no node knows it, and a node said why. */
function definitelyRejected(error: unknown): boolean {
  if (!isOnChainPendingError(error) || error.mayHaveSent !== false) {
    return false;
  }
  return (
    isError(error.sendError, "INSUFFICIENT_FUNDS") ||
    NODE_REJECTION_RE.test(error.message)
  );
}

/**
 * The raw send's throw, mapped once: every endpoint's connection refused, or a definite node rejection on every
 * attempt, is refused; a nonce conflict is the nonce used; anything else (pending with the hash, a timeout) is out.
 */
export function adaptPublicSendError(
  error: unknown
): "out" | "refused" | "nonce-used" {
  if (isPreBroadcastNetworkError(error) || definitelyRejected(error)) {
    return "refused";
  }
  // Duck-typed, as isPreBroadcastNetworkError: module copies can differ.
  if (
    error instanceof Error &&
    error.name === "NonceConflictError" &&
    !isOnChainPendingError(error)
  ) {
    return "nonce-used";
  }
  return "out";
}

/** A copy that never went out: reported not accepted, and the row made a plain bundle row again. */
async function publicCopyNotOut(
  input: BundleSendInput,
  recorded: Recorded,
  adapted: "refused" | "nonce-used"
): Promise<PublicCopyResult> {
  const { publicCopy } = recorded.report;
  if (publicCopy) {
    publicCopy.accepted = false;
    publicCopy.error =
      adapted === "refused"
        ? PUBLIC_COPY_ERRORS.refused
        : PUBLIC_COPY_ERRORS.nonceUsed;
  }
  try {
    // So in-flight checks, reconcile and the sweep stop waiting on it.
    await getNonceManager().markPublicCopyRefused(
      input.session,
      recorded.nonce
    );
  } catch (error) {
    logPublicCopy(
      "Could not mark a public copy not sent",
      error,
      input.chainId
    );
  }
  return { kind: adapted };
}
