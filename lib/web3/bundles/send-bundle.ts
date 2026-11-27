import "server-only";

import { ethers, isError } from "ethers";
import { markBroadcast } from "@/keeperhub-executor/lib/broadcast-marker";
import type { BundleMiss, BundleRun } from "@/lib/db/schema-extensions";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  describeNativeShortfall,
  getNativeSymbol,
} from "@/lib/execute/native-balance";
import { ErrorCategory, logInfo, logSystemError, logWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import type { GasOverrides } from "@/lib/web3/chain-adapter/types";
import { fixedGasLimit, MAX_FEE_GWEI } from "@/lib/web3/gas-defaults";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import {
  isNextBlockSimulationUnsupported,
  simulateSendAtNextBlock,
  TargetBlockPassedError,
} from "@/lib/web3/next-block-simulation";
import { getNonceManager, type NonceSession } from "@/lib/web3/nonce-manager";
import type { BuilderEndpoint } from "./builders";
import {
  BUNDLE_PRE_RECORD_MS,
  BUNDLE_WINDOW_MARGIN_BLOCKS,
  findMinedHash,
  MAX_BUNDLE_WINDOW_MS,
  type MinedHash,
  type ReceiptView,
} from "./bundle-history";
import { type BuilderAnswer, sendBundle } from "./client";
import {
  beforeDeadline,
  DeadlinePassedError,
  type InclusionReads,
  type InclusionResult,
  watchInclusion,
} from "./inclusion";
import {
  maxFeeForTips,
  type PlannedTarget,
  planTips,
  type SkippedTarget,
  toGwei,
} from "./plan";

// The most a user may set as Max Fee; a raised cap never goes above it.
const MAX_FEE_WEI = BigInt(MAX_FEE_GWEI) * BigInt(1_000_000_000);

/**
 * Why a sent bundle was not included: no builder picked it or the call would
 * now revert (both decided, row dropped), or it could not be checked (row
 * left pending: it may still land).
 */
export type NotIncludedReason =
  | "not-picked"
  | "no-longer-needed"
  | "not-checked";

/** One builder's answers over every target: accepted if any was, null when unknown. */
export type BuilderReport = {
  name: string;
  accepted: boolean | null;
  error?: string;
};

/** What a bundle send reports in the step output. */
export type BundleReport = {
  targetBlocks: number[];
  targetTipsGwei: string[];
  builders: BuilderReport[];
  bundleTargetsSkipped?: SkippedTarget[];
};

export type BundleSendOutcome =
  | {
      kind: "included";
      mined: MinedHash;
      gasLimit: bigint;
      report: BundleReport;
    }
  // Only "not-checked" leaves the row pending: the bundle may still land.
  | { kind: "not-included"; reason: NotIncludedReason; report: BundleReport }
  | { kind: "no-builder-accepted"; report: BundleReport }
  // Another transaction took the nonce while the bundle waited.
  | { kind: "used-elsewhere"; report: BundleReport }
  // Refused before signing: nothing was signed or sent.
  | {
      kind: "refused";
      error: string;
      errorClass?: ExecutionErrorType;
      report: Partial<BundleReport>;
    };

type BundleSendInput = {
  session: NonceSession;
  signer: ethers.Signer;
  rpcManager: RpcProviderManager;
  chainId: number;
  call: { from: string; to: string; data: string; value?: bigint };
  contractInterface?: ethers.Interface;
  gas: GasOverrides;
  blocks: number;
  tipIncreasePercent: number;
  builders: readonly BuilderEndpoint[];
  // Picked names this network has no builder for, reported as refused.
  unknownBuilders: readonly string[];
  searcher: ethers.Signer;
  workflowId: string;
  node: NonNullable<BundleRun["node"]>;
  // Set once signed bytes may leave the platform, with what was sent.
  progress: { sent: boolean; report?: BundleReport };
  timing?: { pollMs?: number; windowMs?: number };
};

/** Signing failed (Turnkey or the local key): nothing was sent. */
export class BundleSigningError extends Error {
  override readonly name = "BundleSigningError" as const;
}

/** The bundle's nonce row could not be written: nothing was sent. */
export class BundleRecordError extends Error {
  override readonly name = "BundleRecordError" as const;
}

// Pre-send work under the lock passed its budget: nothing was signed or sent.
const TOO_SLOW: Extract<BundleSendOutcome, { kind: "refused" }> = {
  kind: "refused",
  error:
    "Preparing the bundle took too long (the RPC or the signer was slow), so nothing was sent. Run it again.",
  errorClass: ExecutionErrorType.EXTERNAL,
  report: {},
};

const POLL_MS = 1000;

type Simulated = { block: number; gasEstimate: bigint };

/** Every target simulated in parallel on the latest state; reverts and passed blocks are skipped. */
async function simulateTargets(
  input: BundleSendInput,
  blocks: readonly number[]
): Promise<{
  passed: Simulated[];
  skipped: SkippedTarget[];
  firstError?: unknown;
}> {
  const fixed = fixedGasLimit(input.gas.gasLimitOverride);
  const settled = await Promise.allSettled(
    blocks.map((block) =>
      simulateSendAtNextBlock(input.rpcManager, {
        chainId: input.chainId,
        gasLimit: fixed,
        contractInterface: input.contractInterface,
        tx: input.call,
        options: { targetBlock: block },
      })
    )
  );
  const passed: Simulated[] = [];
  const skipped: SkippedTarget[] = [];
  let firstError: unknown;
  for (const [index, result] of settled.entries()) {
    const block = blocks[index];
    if (result.status === "fulfilled") {
      passed.push({ block, gasEstimate: result.value.gasEstimate });
      continue;
    }
    if (isNextBlockSimulationUnsupported(result.reason)) {
      throw result.reason;
    }
    if (result.reason instanceof TargetBlockPassedError) {
      skipped.push({ block, reason: "target-passed" });
      continue;
    }
    skipped.push({ block, reason: "simulation-failed" });
    firstError ??= result.reason;
  }
  return { passed, skipped, firstError };
}

async function signTargets(
  input: BundleSendInput,
  targets: readonly PlannedTarget[],
  fields: { nonce: number; gasLimit: bigint; maxFee: bigint }
): Promise<string[]> {
  // Equal tips sign to the same bytes: sign each tip once.
  const byTip = new Map<bigint, Promise<string>>();
  const signOne = async (tip: bigint): Promise<string> => {
    const populated = await input.signer.populateTransaction({
      ...input.call,
      nonce: fields.nonce,
      gasLimit: fields.gasLimit,
      maxFeePerGas: fields.maxFee,
      maxPriorityFeePerGas: tip,
      chainId: input.chainId,
      type: 2,
    });
    return await input.signer.signTransaction(populated);
  };
  try {
    return await Promise.all(
      targets.map((target) => {
        let signed = byTip.get(target.tip);
        if (!signed) {
          signed = signOne(target.tip);
          byTip.set(target.tip, signed);
        }
        return signed;
      })
    );
  } catch (error) {
    throw new BundleSigningError(getErrorMessage(error), { cause: error });
  }
}

/** Per builder over every target; picked names the network lacks are refused. */
function aggregateBuilders(
  answers: readonly BuilderAnswer[],
  unknownBuilders: readonly string[]
): BuilderReport[] {
  const reports = new Map<string, BuilderReport>();
  for (const answer of answers) {
    const report = reports.get(answer.builder) ?? {
      name: answer.builder,
      accepted: false,
    };
    if (answer.delivery === "accepted") {
      report.accepted = true;
      report.error = undefined;
    } else if (answer.delivery === "unknown" && report.accepted === false) {
      report.accepted = null;
      report.error = answer.error;
    } else if (report.accepted === false && report.error === undefined) {
      report.error = answer.error;
    }
    reports.set(answer.builder, report);
  }
  const listed = [...reports.values()].map(({ error, ...rest }) =>
    error === undefined ? rest : { ...rest, error }
  );
  return [
    ...listed,
    ...unknownBuilders.map((name) => ({
      name,
      accepted: false,
      error: "not in this network's builder list",
    })),
  ];
}

function receiptView(receipt: ethers.TransactionReceipt | null): ReceiptView {
  return receipt
    ? {
        blockNumber: receipt.blockNumber,
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        gasPrice: receipt.gasPrice,
      }
    : null;
}

function inclusionReads(input: BundleSendInput): InclusionReads {
  const { rpcManager, call } = input;
  return {
    latestBlock: () =>
      rpcManager.executeWithFailover((provider) => provider.getBlockNumber()),
    minedCountAt: (block) =>
      rpcManager.executeWithFailover((provider) =>
        provider.getTransactionCount(call.from, block)
      ),
    receipt: async (hash) =>
      receiptView(
        await rpcManager.executeWithFailover((provider) =>
          provider.getTransactionReceipt(hash)
        )
      ),
  };
}

/** Re-run the call on the latest state: a revert means it is no longer needed. */
async function missReason(
  input: BundleSendInput,
  deadline: number
): Promise<Exclude<NotIncludedReason, "not-checked">> {
  try {
    await beforeDeadline(
      input.rpcManager.executeWithFailover((provider) =>
        provider.call({ ...input.call, blockTag: "latest" })
      ),
      deadline
    );
    return "not-picked";
  } catch (error) {
    // The miss is decided by the chain; an unreadable re-check only loses the detail.
    return isError(error, "CALL_EXCEPTION") ? "no-longer-needed" : "not-picked";
  }
}

function logAfterSend(
  message: string,
  error: unknown,
  chainId: number,
  category: ErrorCategory = ErrorCategory.DATABASE
): void {
  logSystemError(category, `[Bundle] ${message}`, error, {
    plugin_name: "web3",
    action_name: "write-contract",
    chain_id: String(chainId),
  });
}

/** The checks between the gas config and signing: tip, balance, nonce = mined count. */
async function refusalBeforeSigning(
  input: BundleSendInput,
  fees: { gasLimit: bigint; maxFee: bigint; firstTip: bigint },
  nonce: number
): Promise<Extract<BundleSendOutcome, { kind: "refused" }> | undefined> {
  if (fees.firstTip <= BigInt(0)) {
    return {
      kind: "refused",
      error:
        "A bundle needs a priority fee (tip) above 0, or no builder has a reason to include it, so nothing was sent. Set Priority Fee above 0.",
      errorClass: ExecutionErrorType.USER,
      report: {},
    };
  }
  const { rpcManager, call } = input;
  // EIP-1559: a transaction is valid only if the wallet holds its worst case.
  const required = fees.gasLimit * fees.maxFee + (call.value ?? BigInt(0));
  const balance = await rpcManager.executeWithFailover((provider) =>
    provider.getBalance(call.from, "latest")
  );
  if (balance < required) {
    const shortfall = describeNativeShortfall({
      symbol: await getNativeSymbol(input.chainId),
      balance,
      required,
      holder: call.from,
    });
    return { kind: "refused", error: shortfall.message, report: {} };
  }
  const mined = await rpcManager.executeWithFailover((provider) =>
    provider.getTransactionCount(call.from, "latest")
  );
  if (nonce > mined) {
    return {
      kind: "refused",
      error: `An earlier transaction from this wallet (nonce ${mined}) is still waiting to be mined, and a bundle cannot land behind it, so nothing was sent. Run it again once that transaction is mined.`,
      errorClass: ExecutionErrorType.EXTERNAL,
      report: {},
    };
  }
  if (nonce < mined) {
    // A lagging node gave the session a nonce already used: the bundle could never land.
    return {
      kind: "refused",
      error:
        "The wallet's transaction count could not be read consistently (the RPC may be lagging), so nothing was sent. Run it again.",
      errorClass: ExecutionErrorType.EXTERNAL,
      report: {},
    };
  }
  return;
}

/** Targets mined while signing are moved to the skipped list. */
async function dropPassedTargets(
  input: BundleSendInput,
  targets: readonly PlannedTarget[],
  signed: readonly string[]
): Promise<{
  targets: PlannedTarget[];
  signed: string[];
  passed: SkippedTarget[];
}> {
  let latest: number;
  try {
    latest = await input.rpcManager.executeWithFailover((provider) =>
      provider.getBlockNumber()
    );
  } catch {
    // A builder ignores a target already passed; sending it is harmless.
    return { targets: [...targets], signed: [...signed], passed: [] };
  }
  const keep = targets.flatMap((target, index) =>
    target.block > latest ? [{ target, raw: signed[index] }] : []
  );
  return {
    targets: keep.map((entry) => entry.target),
    signed: keep.map((entry) => entry.raw),
    passed: targets
      .filter((target) => target.block <= latest)
      .map((target) => ({ block: target.block, reason: "target-passed" })),
  };
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Send a contract call as a bundle for the next `blocks` blocks, inside the
 * caller's nonce session: simulate each target, sign one transaction per
 * target at one nonce with a rising tip, record the row, send to every
 * builder, then watch the chain until it decides or the row's window passes.
 * Once sent it never throws: an undecided end is "not-checked", row pending.
 */
export async function sendBundleInSession(
  input: BundleSendInput
): Promise<BundleSendOutcome> {
  // The session started when the lock was taken: the pre-send budget runs from then.
  const preRecordEnd = input.session.startedAt.getTime() + BUNDLE_PRE_RECORD_MS;
  try {
    return await sendInBudget(input, preRecordEnd);
  } catch (error) {
    if (error instanceof DeadlinePassedError) {
      return TOO_SLOW;
    }
    throw error;
  }
}

async function sendInBudget(
  input: BundleSendInput,
  preRecordEnd: number
): Promise<BundleSendOutcome> {
  // Abandons a read past the budget, does not cancel it: its late answer is dropped.
  const inBudget = <T>(work: Promise<T>): Promise<T> =>
    beforeDeadline(work, preRecordEnd);
  const provider = input.signer.provider;
  if (!provider) {
    throw new Error("Signer has no provider");
  }
  const latestBlock = await inBudget(
    input.rpcManager.executeWithFailover((p) => p.getBlock("latest"))
  );
  if (!latestBlock) {
    throw new Error("The RPC returned no latest block");
  }
  const latest = latestBlock.number;
  const blocks = Array.from({ length: input.blocks }, (_, i) => latest + i + 1);

  const simulated = await inBudget(simulateTargets(input, blocks));
  if (simulated.passed.length === 0) {
    if (simulated.firstError !== undefined) {
      throw simulated.firstError;
    }
    return {
      kind: "refused",
      error:
        "Every target block was mined before its check finished, so nothing was sent. The RPC may be lagging; run it again.",
      errorClass: ExecutionErrorType.EXTERNAL,
      report: { bundleTargetsSkipped: simulated.skipped },
    };
  }

  const estimates = simulated.passed.map((target) => target.gasEstimate);
  const strategy = getGasStrategy();
  const [gasConfig, tipLimit] = await inBudget(
    Promise.all([
      strategy.getGasConfig(
        provider,
        estimates.reduce((max, gas) => (gas > max ? gas : max)),
        input.chainId,
        input.gas.multiplierOverride,
        input.gas.gasLimitOverride,
        input.rpcManager,
        input.gas.priorityFeeOverride,
        input.gas.maxFeeOverride
      ),
      strategy.priorityFeeLimit(input.chainId),
    ])
  );
  const passedBlocks = simulated.passed.map((target) => target.block);
  const parent =
    latestBlock.baseFeePerGas === null ||
    latestBlock.baseFeePerGas === undefined
      ? null
      : {
          baseFee: latestBlock.baseFeePerGas,
          gasUsed: latestBlock.gasUsed,
          gasLimit: latestBlock.gasLimit,
        };
  // Raise the cap so later tips are paid as planned, held to Max Fee (or the most it may be).
  const raisedMaxFee = maxFeeForTips({
    estimatedMaxFee: gasConfig.maxFeePerGas,
    firstTip: gasConfig.maxPriorityFeePerGas,
    increasePercent: input.tipIncreasePercent,
    latest,
    blocks: passedBlocks,
    tipLimit,
    parent,
  });
  const feeCeiling = input.gas.maxFeeOverride ?? MAX_FEE_WEI;
  const maxFee = raisedMaxFee < feeCeiling ? raisedMaxFee : feeCeiling;
  const userMaxFeeBinds =
    input.gas.maxFeeOverride !== undefined &&
    raisedMaxFee >= input.gas.maxFeeOverride;
  const plan = planTips({
    latest,
    parent,
    firstTip: gasConfig.maxPriorityFeePerGas,
    maxFee,
    increasePercent: input.tipIncreasePercent,
    blocks: passedBlocks,
    tipLimit,
  });
  const skipped = [...simulated.skipped, ...plan.skipped];
  if (plan.targets.length === 0) {
    // A revert on some targets says more than the fee on the rest.
    if (simulated.firstError !== undefined) {
      throw simulated.firstError;
    }
    return {
      kind: "refused",
      error: maxFeeRefusal(maxFee, plan.lowestSkippedBaseFee, userMaxFeeBinds),
      // The user's own Max Fee caused it when it set the cap; otherwise the network's fees did.
      errorClass: userMaxFeeBinds
        ? ExecutionErrorType.USER
        : ExecutionErrorType.EXTERNAL,
      report: { bundleTargetsSkipped: sortedSkips(skipped) },
    };
  }

  const nonceManager = getNonceManager();
  const nonce = nonceManager.getNextNonce(input.session);
  const refusal = await inBudget(
    refusalBeforeSigning(
      input,
      {
        gasLimit: gasConfig.gasLimit,
        maxFee,
        firstTip: gasConfig.maxPriorityFeePerGas,
      },
      nonce
    )
  );
  if (refusal) {
    return refusal;
  }
  if (Date.now() >= preRecordEnd) {
    return TOO_SLOW;
  }
  const allSigned = await inBudget(
    signTargets(input, plan.targets, {
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFee,
    })
  );
  const live = await inBudget(
    dropPassedTargets(input, plan.targets, allSigned)
  );
  skipped.push(...live.passed);
  const skippedField =
    skipped.length > 0 ? { bundleTargetsSkipped: sortedSkips(skipped) } : {};
  if (live.targets.length === 0) {
    return {
      kind: "refused",
      error:
        "Every target block was mined while the bundle was being signed, so nothing was sent. Run it again.",
      errorClass: ExecutionErrorType.EXTERNAL,
      report: skippedField,
    };
  }

  const hashes = [...new Set(live.signed.map((raw) => ethers.keccak256(raw)))];
  const lastTarget = Math.max(...live.targets.map((target) => target.block));
  // The last check before anything leaves: the hold must stay within its budget.
  if (Date.now() >= preRecordEnd) {
    return TOO_SLOW;
  }
  let stepHashes: string[];
  try {
    stepHashes = await nonceManager.recordBundle(input.session, nonce, {
      hashes,
      lastTargetBlock: lastTarget,
      workflowId: input.workflowId,
      gasPrice: maxFee.toString(),
      node: input.node,
    });
  } catch (error) {
    throw new BundleRecordError(getErrorMessage(error), { cause: error });
  }
  // Set a few ms after the row's submittedAt, so the watch ends just after the row's window (harmless).
  const windowEnd =
    Date.now() + (input.timing?.windowMs ?? MAX_BUNDLE_WINDOW_MS);
  const report: BundleReport = {
    targetBlocks: live.targets.map((target) => target.block),
    targetTipsGwei: live.targets.map((target) => toGwei(target.tip)),
    builders: [],
    ...skippedField,
  };
  input.progress.sent = true;
  input.progress.report = report;

  try {
    return await afterRecord(input, {
      nonce,
      hashes,
      stepHashes: [...new Set([...hashes, ...stepHashes])],
      scanFrom: Math.max(0, latest - BUNDLE_WINDOW_MARGIN_BLOCKS),
      lastTarget,
      windowEnd,
      targets: live.targets,
      signed: live.signed,
      gasLimit: gasConfig.gasLimit,
      report,
    });
  } catch (error) {
    // Never release the lock while a target can land; the row stays pending.
    logAfterSend(
      "The bundle's outcome could not be decided",
      error,
      input.chainId,
      ErrorCategory.WORKFLOW_ENGINE
    );
    await waitPastTargets(input, lastTarget, windowEnd);
    return { kind: "not-included", reason: "not-checked", report };
  }
}

/** Hold the lock until the chain passes the targets (healthy chain) or the window ends. */
async function waitPastTargets(
  input: BundleSendInput,
  lastTarget: number,
  windowEnd: number
): Promise<void> {
  const pollMs = input.timing?.pollMs ?? POLL_MS;
  while (Date.now() < windowEnd) {
    try {
      const latest = await beforeDeadline(
        input.rpcManager.executeWithFailover((provider) =>
          provider.getBlockNumber()
        ),
        windowEnd
      );
      if (latest > lastTarget + BUNDLE_WINDOW_MARGIN_BLOCKS) {
        return;
      }
    } catch {
      // Unreadable: keep holding until the window ends.
    }
    await sleepFor(Math.min(pollMs, windowEnd - Date.now()));
  }
}

// Advice only when the user's own Max Fee set the cap. Otherwise the cap was
// held at MAX_FEE_GWEI: with a base fee known, the estimate cannot leave a target out.
function maxFeeRefusal(
  maxFee: bigint,
  projected: bigint | undefined,
  userMaxFeeBinds: boolean
): string {
  const reach =
    projected === undefined
      ? "the base fee the target blocks may reach"
      : `the base fee the target blocks may reach (${groupedGwei(projected)} gwei)`;
  if (userMaxFeeBinds) {
    return `Max fee ${groupedGwei(maxFee)} gwei is below ${reach}, so nothing was sent. Raise the max fee or leave it empty.`;
  }
  return `The fee cap of ${groupedGwei(maxFee)} gwei, the most a bundle step signs, is below ${reach}, so nothing was sent. Run it again later.`;
}

// Gwei with thousands separators ("10,000", "1,234.5").
function groupedGwei(wei: bigint): string {
  const [whole, fraction] = toGwei(wei).split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function sortedSkips(skipped: SkippedTarget[]): SkippedTarget[] {
  return [...skipped].sort((a, b) => a.block - b.block);
}

type Recorded = {
  nonce: number;
  hashes: string[];
  // This send's hashes first, then the ones this step signed at this nonce before.
  stepHashes: string[];
  // The oldest block the transaction that used the nonce can be in.
  scanFrom: number;
  lastTarget: number;
  windowEnd: number;
  targets: PlannedTarget[];
  signed: string[];
  gasLimit: bigint;
  report: BundleReport;
};

async function afterRecord(
  input: BundleSendInput,
  recorded: Recorded
): Promise<BundleSendOutcome> {
  const { nonce, report } = recorded;
  markBroadcast();
  let answers: BuilderAnswer[] | undefined;
  try {
    answers = (
      await Promise.all(
        recorded.targets.map((target, index) =>
          sendBundle({
            builders: input.builders,
            signedTxs: [recorded.signed[index]],
            targetBlock: target.block,
            searcher: input.searcher,
          })
        )
      )
    ).flat();
  } catch (error) {
    // Some builders may have the bundle: watch the chain as if they all do.
    logAfterSend(
      "Sending the bundle failed part way",
      error,
      input.chainId,
      ErrorCategory.EXTERNAL_SERVICE
    );
  }
  for (const answer of answers ?? []) {
    logInfo("[Bundle] Builder answered", {
      builder: answer.builder,
      delivery: answer.delivery,
      chain_id: String(input.chainId),
    });
  }
  report.builders = aggregateBuilders(answers ?? [], input.unknownBuilders);
  if (
    answers !== undefined &&
    answers.length > 0 &&
    answers.every((answer) => answer.delivery === "refused")
  ) {
    await dropNonce(input, nonce, "no-builder-accepted");
    return { kind: "no-builder-accepted", report };
  }

  const watched = await watchInclusion(
    {
      nonce,
      hashes: recorded.hashes,
      lastTarget: recorded.lastTarget,
      pollMs: input.timing?.pollMs ?? POLL_MS,
      windowEnd: recorded.windowEnd,
    },
    inclusionReads(input)
  );
  return await settleWatch(input, watched, recorded);
}

async function settleWatch(
  input: BundleSendInput,
  watched: InclusionResult,
  recorded: Recorded
): Promise<BundleSendOutcome> {
  const { nonce, report } = recorded;
  switch (watched.kind) {
    case "included":
      try {
        // Only a receipt-backed hash confirms the nonce.
        await getNonceManager().confirmNonce(
          input.session,
          nonce,
          watched.mined.hash
        );
      } catch (error) {
        // The next session's reconcile confirms it from the row's hashes.
        logAfterSend(
          "Could not confirm a landed bundle's nonce",
          error,
          input.chainId
        );
      }
      return {
        kind: "included",
        mined: watched.mined,
        gasLimit: recorded.gasLimit,
        report,
      };
    case "not-included": {
      // The window end on purpose: a miss decided in the last poll skips the re-check (not-picked).
      const reason = await missReason(input, recorded.windowEnd);
      await dropNonce(input, nonce, reason);
      return { kind: "not-included", reason, report };
    }
    case "used-elsewhere":
      return await recheckUsedElsewhere(input, recorded);
    default:
      // The window passed undecided: the row stays pending for reconcile.
      return { kind: "not-included", reason: "not-checked", report };
  }
}

type RecheckReads = {
  receipt: (hash: string) => Promise<ReceiptView>;
  head: () => Promise<number>;
  // A block with its transactions; null when the node does not have it.
  block: (block: number) => Promise<ethers.Block | null>;
};

/** The fallback endpoint when there is one, else the primary with failover. */
function recheckReads(input: BundleSendInput): RecheckReads {
  const fallback = input.rpcManager.getFallbackProvider();
  if (fallback) {
    return {
      receipt: async (hash) =>
        receiptView(await fallback.getTransactionReceipt(hash)),
      head: () => fallback.getBlockNumber(),
      block: (block) => fallback.getBlock(block, true),
    };
  }
  const { rpcManager } = input;
  return {
    receipt: inclusionReads(input).receipt,
    head: () =>
      rpcManager.executeWithFailover((provider) => provider.getBlockNumber()),
    block: (block) =>
      rpcManager.executeWithFailover((provider) =>
        provider.getBlock(block, true)
      ),
  };
}

/**
 * The hash mined from `from` at `nonce`, read block by block from `oldestBlock`
 * up to the head (it is usually near the start); a block the node lacks is skipped.
 */
async function hashAtNonce(
  reads: RecheckReads,
  from: string,
  nonce: number,
  oldestBlock: number
): Promise<string | undefined> {
  const sender = from.toLowerCase();
  const head = await reads.head();
  for (let block = oldestBlock; block <= head; block += 1) {
    const found = await reads.block(block);
    const used = found?.prefetchedTransactions.find(
      (tx) => tx.from.toLowerCase() === sender && tx.nonce === nonce
    );
    if (used) {
      return used.hash.toLowerCase();
    }
  }
  return;
}

/**
 * Used elsewhere only on proof: a transaction from the wallet mined at this
 * nonce whose hash this step never signed. This step's receipts are read
 * again first (a lagging index must not fail a landing); without proof the
 * row stays pending for the sweep. Counts alone never decide it.
 */
async function recheckUsedElsewhere(
  input: BundleSendInput,
  recorded: Recorded
): Promise<BundleSendOutcome> {
  const undecided: BundleSendOutcome = {
    kind: "not-included",
    reason: "not-checked",
    report: recorded.report,
  };
  const reads = recheckReads(input);
  const ours = new Set(recorded.stepHashes.map((hash) => hash.toLowerCase()));
  let found: { mined?: MinedHash; usedBy?: string };
  try {
    // The window end on purpose: a decision in the watch's last poll skips this (not-checked).
    found = await beforeDeadline(
      (async () => {
        const { mined } = await findMinedHash(
          recorded.stepHashes,
          reads.receipt
        );
        if (mined) {
          return { mined };
        }
        return {
          usedBy: await hashAtNonce(
            reads,
            input.call.from,
            recorded.nonce,
            recorded.scanFrom
          ),
        };
      })(),
      recorded.windowEnd
    );
  } catch (error) {
    logWarn("[Bundle] The nonce's use could not be read; left for reconcile", {
      chain_id: String(input.chainId),
      error: error instanceof Error ? error.name : "unknown",
    });
    return undecided;
  }
  if (found.mined) {
    return await settleWatch(
      input,
      { kind: "included", mined: found.mined },
      recorded
    );
  }
  if (found.usedBy === undefined || ours.has(found.usedBy)) {
    // Not found, or ours without a receipt yet: the sweep settles it.
    return undecided;
  }
  return { kind: "used-elsewhere", report: recorded.report };
}

async function dropNonce(
  input: BundleSendInput,
  nonce: number,
  missed: BundleMiss
): Promise<void> {
  try {
    await getNonceManager().markNonceDropped(input.session, nonce, missed);
  } catch (error) {
    // Left pending, the row is dropped by reconcile once its window closes.
    logAfterSend(
      "Could not release a missed bundle's nonce",
      error,
      input.chainId
    );
  }
}
