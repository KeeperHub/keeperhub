/**
 * Send as Bundle for Write Contract: the checks before anything is sent, the
 * in-flight skip, and the send inside the wallet's nonce session. Not a step file.
 */
import "server-only";

import { ethers } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getNativeSymbol } from "@/lib/execute/native-balance";
import {
  ErrorCategory,
  logInfo,
  logSystemError,
  logUserError,
} from "@/lib/logging";
import { declaredErrorClass, type RpcProviderManager } from "@/lib/rpc/providers";
import { SIGNER_MODE, type SignerMode } from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import {
  type BuilderEndpoint,
  loadChainBuilders,
  selectBuilders,
} from "@/lib/web3/bundles/builders";
import {
  BUNDLE_RUN_MARGIN_MS,
  LONGEST_BUNDLE_HOLD_MS,
  type MinedHash,
  minedOf,
} from "@/lib/web3/bundles/bundle-history";
import { bundleInFlight, type InFlight } from "@/lib/web3/bundles/in-flight";
import { bundleLoopRefusal } from "@/lib/web3/bundles/loop-rule";
import { isBundleSendEnabledForOrg } from "@/lib/web3/bundles/rollout";
import { getSearcherWallet } from "@/lib/web3/bundles/searcher-key";
import {
  BundleRecordError,
  type BundleReport,
  type BundleSendOutcome,
  BundleSigningError,
  type NotIncludedReason,
  runTimeRefusal,
  STEP_HOLD,
  type SendAheadReport,
  sendAheadPlanNow,
  sendBundleInSession,
  TRIGGER_NOT_REACHED_ERROR,
  walletBusyRefusal,
} from "@/lib/web3/bundles/send-bundle";
import {
  type BundleSettings,
  type BundleSettingsInput,
  NOT_BEFORE_UNSUPPORTED_ERROR,
  readBundleSettings,
} from "@/lib/web3/bundles/settings";
import { minBlockGapSeconds } from "@/lib/web3/beacon-slots";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { GasOverrides } from "@/lib/web3/chain-adapter/types";
import {
  classifyRevert,
  formatContractError,
} from "@/lib/web3/decode-revert-error";
import { buildErrorDecodeInterface } from "@/lib/web3/extra-error-abis";
import { preflightGasBalance } from "@/lib/web3/gas-preflight";
import { maxFeeCapFailure } from "@/lib/web3/max-fee-cap-failure";
import type { TriggerBlock } from "@/lib/web3/next-block-limits";
import {
  getNextBlockSimulation,
  isNextBlockSimulationUnsupported,
  isTriggerBlockNotReached,
} from "@/lib/web3/next-block-simulation";
import { minedRevertError } from "@/lib/web3/onchain-revert";
import {
  type BundleSendMode,
  bundleModeOf,
  bundleSafeRefusal,
  SEND_MODE,
  sendAsSubject,
  USE_NORMAL_HINT,
} from "@/lib/web3/send-mode";
import type { ExecutedCall } from "@/lib/web3/trace-decode";
import type { TraceExecutedCallOptions } from "@/lib/web3/trace-executed-call";
import {
  linkBundleReservation,
  NonceLockWaitEndedError,
} from "@/lib/web3/nonce-manager";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import { initializeWalletSigner } from "@/lib/web3/wallet-helpers";
import {
  BUNDLE_STEP_ACTION_TYPES,
  RUN_OUTCOME_OUTPUT,
} from "@/lib/workflow/executor/run-outcome-keys";
import { runDeadlineAt } from "@/lib/workflow/executor/runner-constants";
import type {
  WriteContractCoreInput,
  WriteContractResult,
} from "./write-contract-core";

type Failure = Extract<WriteContractResult, { success: false }>;

/** The start of a refusal, naming the step's own bundle mode. */
function setTo(mode: BundleSendMode): string {
  return `This step is set to ${sendAsSubject(mode)}, but`;
}

/** The step context a bundle needs: a workflow run of a Write Contract node. */
type BundleStepContext = NonNullable<WriteContractCoreInput["_context"]>;

/** Everything checked before the wallet is touched. */
export type BundleRoute = {
  // The step's mode, which is also its route output.
  mode: BundleSendMode;
  settings: BundleSettings;
  builders: BuilderEndpoint[];
  unknownBuilders: string[];
  searcher: ethers.Wallet;
  workflowId: string;
  executionId: string;
  node: { id: string; name: string; iterationIndex?: number };
  valueReservationId?: string;
};

function userFailure(error: string): { ok: false; failure: Failure } {
  return {
    ok: false,
    failure: { success: false, error, errorClass: ExecutionErrorType.USER },
  };
}

/**
 * The refusals before anything is sent, in order: rollout, where the step
 * runs, its settings, the network's builders, then the platform searcher key.
 */
export async function prepareBundleRoute(options: {
  organizationId: string;
  chainId: number;
  context: BundleStepContext | undefined;
  config: BundleSettingsInput & { sendMode?: unknown; usePrivateMempool?: unknown };
}): Promise<
  { ok: true; route: BundleRoute } | { ok: false; failure: Failure }
> {
  const mode = bundleModeOf(options.config);
  const setToBundle = setTo(mode);
  if (!isBundleSendEnabledForOrg(options.organizationId)) {
    return userFailure(
      `${setToBundle} bundles are not enabled for this organization. ${USE_NORMAL_HINT}`
    );
  }
  const { context } = options;
  if (
    !(
      context?.executionId &&
      context.workflowId &&
      context.nodeId &&
      context.nodeType &&
      BUNDLE_STEP_ACTION_TYPES.includes(context.nodeType)
    )
  ) {
    return userFailure(
      `${setToBundle} bundles only run in a Write Contract step of a workflow, not from a direct API or MCP call. ${USE_NORMAL_HINT}`
    );
  }
  // A nested body's iteration index repeats under every outer iteration, so a replay could not be told apart.
  const loopRefusal = bundleLoopRefusal(context.loopDepth ?? 0);
  if (loopRefusal) {
    return userFailure(loopRefusal);
  }
  const read = readBundleSettings(options.config);
  if (!read.ok) {
    return userFailure(read.error);
  }
  if (
    (read.settings.sendAhead || read.settings.notBeforeRefusal) &&
    minBlockGapSeconds(options.chainId) === undefined
  ) {
    return userFailure(
      `${NOT_BEFORE_UNSUPPORTED_ERROR} Nothing was sent. Clear Not before, or use a network with fixed slots such as Ethereum.`
    );
  }
  const available = await loadChainBuilders(options.chainId);
  if (available.length === 0) {
    return userFailure(
      `${setToBundle} this network has no block builders to send bundles to. ${USE_NORMAL_HINT}`
    );
  }
  const { endpoints, unknown } = selectBuilders(
    available,
    read.settings.builders
  );
  if (endpoints.length === 0) {
    return userFailure(
      `None of the picked builders (${unknown.join(", ")}) is in this network's builder list. Pick from: ${available.map((builder) => builder.name).join(", ")}.`
    );
  }
  let searcher: ethers.Wallet;
  try {
    searcher = getSearcherWallet();
  } catch (error) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[Bundle] The searcher key is missing or invalid",
      error,
      { plugin_name: "web3", action_name: "write-contract" }
    );
    return {
      ok: false,
      failure: {
        success: false,
        error: `${setToBundle} bundles are not set up on this server, so nothing was sent. ${USE_NORMAL_HINT}`,
        errorClass: ExecutionErrorType.SYSTEM,
      },
    };
  }
  return {
    ok: true,
    route: {
      mode,
      settings: read.settings,
      builders: endpoints,
      unknownBuilders: unknown,
      searcher,
      workflowId: context.workflowId,
      executionId: context.executionId,
      node: {
        id: context.nodeId,
        name: context.nodeName || context.nodeId,
        ...(context.iterationIndex !== undefined && {
          iterationIndex: context.iterationIndex,
        }),
      },
      ...(context.valueReservationId && {
        valueReservationId: context.valueReservationId,
      }),
    },
  };
}

/** Safe and Roles connections send through their own path, which cannot bundle yet. */
export function bundleSignerRefusal(
  signerMode: SignerMode,
  mode: BundleSendMode
): Failure | undefined {
  if (signerMode.kind === SIGNER_MODE.EOA) {
    return;
  }
  return {
    success: false,
    error: bundleSafeRefusal(mode),
    errorClass: ExecutionErrorType.USER,
  };
}

/** The bundle output keys of a result, for a softened failure to keep. */
export function bundleOutputsOf(
  result: WriteContractResult
): Partial<BundleReport> {
  const {
    targetBlocks,
    targetTipsGwei,
    builders,
    bundleTargetsSkipped,
    notBefore,
    firstAllowedBlock,
    latestBlock,
    sendAheadBlocks,
    publicCopy,
    fallbackSent,
    fallbackNotSentReason,
  } = result;
  return {
    ...(publicCopy && { publicCopy }),
    ...(fallbackSent !== undefined && { fallbackSent }),
    ...(fallbackNotSentReason && { fallbackNotSentReason }),
    ...(targetBlocks && { targetBlocks }),
    ...(targetTipsGwei && { targetTipsGwei }),
    ...(builders && { builders }),
    ...(bundleTargetsSkipped && { bundleTargetsSkipped }),
    ...(notBefore !== undefined && { notBefore }),
    ...(firstAllowedBlock !== undefined && { firstAllowedBlock }),
    ...(latestBlock !== undefined && { latestBlock }),
    ...(sendAheadBlocks !== undefined && { sendAheadBlocks }),
  };
}

type BundleWrite = {
  route: BundleRoute;
  chainId: number;
  organizationId: string;
  walletAddress: string;
  rpcUrl: string;
  rpcManager: RpcProviderManager;
  // Traces the landed call; resolves the read RPC itself and swallows failures.
  traceExecuted: (
    hash: string,
    options: TraceExecutedCallOptions
  ) => Promise<ExecutedCall | undefined>;
  // The block that triggered the run, if any: the targets start after it.
  triggerBlock?: TriggerBlock;
  txContext: TransactionContext;
  contractAddress: string;
  parsedAbi: unknown[];
  abiFunction: string;
  functionKey: string;
  args: unknown[];
  value?: bigint;
  gas: GasOverrides;
  errorAbis?: string[];
};

async function linkOf(
  chainId: number,
  hash: string
): Promise<string | undefined> {
  try {
    return await getChainAdapter(chainId).getTransactionUrl(hash);
  } catch {
    // The hash alone is enough to look up the transaction.
    return;
  }
}

// Least time worth starting the landed call's trace with; with less it is skipped.
const MIN_TRACE_MS = 2000;

/**
 * The landed call's trace (optional output), bounded by the run's time left
 * less the margin to write the run, so a slow trace never gets the run stopped.
 */
async function traceWithinRun(
  write: BundleWrite,
  hash: string
): Promise<ExecutedCall | undefined> {
  const trace = (): Promise<ExecutedCall | undefined> =>
    write.traceExecuted(hash, {
      target: write.contractAddress,
      abi: write.parsedAbi,
      functionName: write.abiFunction,
    });
  const deadline = runDeadlineAt();
  if (deadline === undefined) {
    return await trace();
  }
  const leftMs = deadline - BUNDLE_RUN_MARGIN_MS - Date.now();
  if (leftMs < MIN_TRACE_MS) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), leftMs);
  });
  try {
    return await Promise.race([trace(), timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a mined, reverted public copy cost: the fee in the native token, and the gas units. */
async function paidGasText(
  chainId: number,
  mined: MinedHash
): Promise<string> {
  const units = mined.gasUnits?.toString() ?? "unknown";
  if (mined.feeWei === null) {
    return `${units} gas units`;
  }
  let symbol = "of the native token";
  try {
    symbol = await getNativeSymbol(chainId);
  } catch {
    // The amount alone is still right.
  }
  return `${ethers.formatEther(mined.feeWei)} ${symbol} (${units} gas units)`;
}

/** The failure text of a public copy mined and reverted; lostRace: the call reverts after its block too. */
async function paidRevertText(
  write: BundleWrite,
  mined: MinedHash,
  revert: string,
  lostRace: boolean
): Promise<string> {
  const paid = await paidGasText(write.chainId, mined);
  if (lostRace) {
    return `Most likely another transaction made the call first: your public copy (${mined.hash}) was mined in block ${mined.blockNumber ?? "unknown"} and reverted (${revert}), and the wallet paid ${paid} in gas.`;
  }
  return `${revert}. The public copy was mined and reverted, so the wallet paid its gas: ${paid}.`;
}

async function includedResult(
  write: BundleWrite,
  outcome: {
    mined: MinedHash;
    gasLimit: bigint | null;
    report: Partial<BundleReport>;
    paidRevert?: { lostRace: boolean };
  },
  contractInterface: ethers.Interface | undefined
): Promise<WriteContractResult> {
  const { mined, report } = outcome;
  const transactionLink = await linkOf(write.chainId, mined.hash);
  const sent = {
    route: write.route.mode,
    included: true,
    ...(mined.blockNumber !== null && { includedBlock: mined.blockNumber }),
    transactionHash: mined.hash,
    chainId: write.chainId,
    ...(transactionLink && { transactionLink }),
    ...report,
  };
  if (!mined.succeeded) {
    const error = minedRevertError(
      {
        hash: mined.hash,
        blockNumber: mined.blockNumber ?? 0,
        gasUsed: mined.gasUnits ?? undefined,
      },
      outcome.gasLimit,
      write.gas.gasLimitOverride !== undefined
    );
    const revert = formatContractError(
      error,
      buildErrorDecodeInterface(contractInterface, write.errorAbis)
    );
    if (!outcome.paidRevert) {
      return { success: false, error: revert, broadcastAttempted: true, ...sent };
    }
    return {
      success: false,
      error: await paidRevertText(
        write,
        mined,
        revert,
        outcome.paidRevert.lostRace
      ),
      broadcastAttempted: true,
      ...sent,
      ...(mined.feeWei !== null && { gasUsed: mined.feeWei.toString() }),
      ...(mined.gasUnits !== null && {
        gasUsedUnits: mined.gasUnits.toString(),
      }),
    };
  }
  const gasUnits = mined.gasUnits ?? BigInt(0);
  const fee = mined.feeWei ?? BigInt(0);
  const executedCall = await traceWithinRun(write, mined.hash);
  return {
    success: true,
    ...sent,
    gasUsed: fee.toString(),
    gasUsedUnits: gasUnits.toString(),
    effectiveGasPrice: (gasUnits > BigInt(0)
      ? fee / gasUnits
      : BigInt(0)
    ).toString(),
    result: undefined,
    executedCall,
  };
}

const NO_BUILDER_ACCEPTED =
  "No block builder accepted the bundle, so it is not expected to be included.";

// Bundle and public: no builder took it and its public copy did not go out either.
const NO_BUILDER_NO_COPY =
  "No block builder accepted the bundle, and its public copy was not sent (see publicCopy.error), so it is not expected to be included. See this step's builders output for each builder's answer.";

const OUTCOME_ERRORS = {
  "no-builder-accepted": {
    error: `${NO_BUILDER_ACCEPTED} See this step's builders output for each builder's answer.`,
    errorClass: ExecutionErrorType.EXTERNAL,
  },
  "used-elsewhere": {
    error:
      "Another transaction from this wallet (for example a send from outside KeeperHub) used the bundle's nonce while it waited, so the bundle cannot be included. KeeperHub's own sends from this wallet wait for the bundle; check what else sends from it.",
    errorClass: ExecutionErrorType.USER,
  },
} as const;

/** Not included, no transactionHash: the finalizer would verify an unmined hash. */
function notIncludedResult(
  mode: BundleSendMode,
  reason: NotIncludedReason,
  report: Partial<BundleReport>
): WriteContractResult {
  return {
    success: true,
    route: mode,
    included: false,
    [RUN_OUTCOME_OUTPUT.notIncludedReasonKey]: reason,
    ...report,
  };
}

/** A public copy out and not mined yet: the one miss with a transactionHash, so the run ends unconfirmed. */
async function publicPendingResult(
  write: BundleWrite,
  hash: string,
  report: Partial<BundleReport>
): Promise<WriteContractResult> {
  const transactionLink = await linkOf(write.chainId, hash);
  return {
    success: true,
    route: write.route.mode,
    included: false,
    pending: true,
    transactionHash: hash,
    chainId: write.chainId,
    ...(transactionLink && { transactionLink }),
    ...report,
  };
}

const FALLBACK_REFUSED =
  "No public RPC could be reached or every RPC rejected it, so the fallback copy was not sent; nothing was mined and the nonce was released.";

function fallbackRefusedResult(
  mode: BundleSendMode,
  report: Partial<BundleReport>
): WriteContractResult {
  return {
    success: false,
    error: `${FALLBACK_REFUSED} Check the network's RPC and the wallet's balance.`,
    errorClass: ExecutionErrorType.EXTERNAL,
    route: mode,
    included: false,
    broadcastAttempted: true,
    fallbackSent: false,
    ...report,
  };
}

async function resultOf(
  write: BundleWrite,
  outcome: BundleSendOutcome,
  contractInterface: ethers.Interface | undefined
): Promise<WriteContractResult> {
  switch (outcome.kind) {
    case "included":
      return await includedResult(write, outcome, contractInterface);
    case "not-included":
      return notIncludedResult(write.route.mode, outcome.reason, outcome.report);
    case "public-pending":
      return await publicPendingResult(write, outcome.hash, outcome.report);
    case "fallback-refused":
      return fallbackRefusedResult(write.route.mode, outcome.report);
    case "waiting":
      return waitingResult(outcome.report);
    case "refused":
      return {
        success: false,
        error: outcome.error,
        ...(outcome.errorClass && { errorClass: outcome.errorClass }),
        broadcastAttempted: false,
        ...outcome.report,
      };
    default:
      return {
        success: false,
        ...OUTCOME_ERRORS[outcome.kind],
        ...(outcome.kind === "no-builder-accepted" &&
          write.route.mode === SEND_MODE.BUNDLE_AND_PUBLIC && {
            error: NO_BUILDER_NO_COPY,
          }),
        route: write.route.mode,
        included: false,
        broadcastAttempted: true,
        ...outcome.report,
      };
  }
}

// Advice about Simulate at or the timestamp offset: fields bundle mode ignores.
const TIMING_ADVICE_RE = /"Simulate at"|"Next block timestamp offset"/;

/** A failure before anything was sent: nothing signed reached a builder. */
function failureOf(
  error: unknown,
  write: BundleWrite,
  contractInterface: ethers.Interface | undefined
): Failure {
  const labels = {
    plugin_name: "web3",
    action_name: "write-contract",
    chain_id: String(write.chainId),
  };
  if (isNextBlockSimulationUnsupported(error)) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Bundle] The network's RPC cannot simulate the target blocks",
      error,
      labels
    );
    return {
      success: false,
      error: `${setTo(write.route.mode)} this network's RPC cannot simulate the target blocks, which a bundle needs. Use an RPC that supports it, or set Send as to Normal transaction (sendMode: "${SEND_MODE.TRANSACTION}").`,
      errorClass: ExecutionErrorType.USER,
      broadcastAttempted: false,
    };
  }
  if (error instanceof BundleSigningError) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Bundle] Signing the bundle failed",
      error,
      labels
    );
    return {
      success: false,
      error: `Signing the bundle failed, so nothing was sent: ${error.message}`,
      broadcastAttempted: false,
    };
  }
  if (error instanceof BundleRecordError) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Bundle] Recording the bundle failed",
      error.cause ?? error,
      labels
    );
    return {
      success: false,
      error:
        "The bundle could not be recorded before sending, so nothing was sent. Run it again.",
      errorClass: ExecutionErrorType.SYSTEM,
      broadcastAttempted: false,
    };
  }
  logUserError(
    ErrorCategory.NETWORK_RPC,
    "[Bundle] Write Contract bundle failed before sending",
    error,
    labels
  );
  const simulation = getNextBlockSimulation(error);
  const message = formatContractError(
    error,
    buildErrorDecodeInterface(contractInterface, write.errorAbis)
  );
  const rejection = classifyRevert(error, contractInterface);
  return {
    success: false,
    error: TIMING_ADVICE_RE.test(message)
      ? `The target blocks' times could not be predicted on this network (the RPC may be lagging), so nothing was sent. Run it again, or set Send as to Normal transaction (sendMode: "${SEND_MODE.TRANSACTION}").`
      : `${message}${simulation ? ` (simulated as of target block ${simulation.assumedBlockNumber}, timestamp ${simulation.assumedTimestamp})` : ""}`,
    ...(simulation && { simulation }),
    // A redirecting RPC preference of the user's stays their fault behind this text.
    ...declaredErrorClass(error),
    broadcastAttempted: false,
    ...(rejection.kind === "unknown" ? {} : { rejection }),
  };
}

/** Not before is too far ahead: nothing signed, the run goes on and ends Skipped. */
function waitingResult(
  report: Partial<BundleReport> & SendAheadReport
): WriteContractResult {
  return {
    success: true,
    route: RUN_OUTCOME_OUTPUT.waitingRoute,
    included: false,
    ...report,
  };
}

// A pre-lock end, or whether the send would start past the next block.
type AheadCheck = { done: WriteContractResult } | { sendsAhead: boolean };

/** Before the lock: waiting when Not before's first allowed block is still too far ahead. */
async function waitingCheck(write: BundleWrite): Promise<AheadCheck> {
  const { sendAhead, blocks } = write.route.settings;
  if (!sendAhead) {
    return { sendsAhead: false };
  }
  let checked: Awaited<ReturnType<typeof sendAheadPlanNow>>;
  try {
    checked = await sendAheadPlanNow({
      rpcManager: write.rpcManager,
      chainId: write.chainId,
      triggerBlock: write.triggerBlock,
      sendAhead,
      blocks,
    });
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Bundle] Could not read the latest block for Not before",
      error,
      {
        plugin_name: "web3",
        action_name: "write-contract",
        chain_id: String(write.chainId),
      }
    );
    return {
      done: {
        success: false,
        error: isTriggerBlockNotReached(error)
          ? TRIGGER_NOT_REACHED_ERROR
          : `The latest block could not be read to check Not before, so nothing was sent: ${getErrorMessage(error)}`,
        errorClass: ExecutionErrorType.EXTERNAL,
        broadcastAttempted: false,
      },
    };
  }
  if (checked.plan.kind === "send") {
    return { sendsAhead: checked.plan.targets[0] > checked.latest + 1 };
  }
  logInfo("[Bundle] Waiting: Not before is still too far ahead", {
    workflow_id: write.route.workflowId,
    chain_id: String(write.chainId),
  });
  return {
    done: waitingResult({
      notBefore: sendAhead.notBefore,
      firstAllowedBlock: checked.plan.firstAllowedBlock,
      latestBlock: checked.latest,
      sendAheadBlocks: sendAhead.blocks,
    }),
  };
}

/** Skipped behind another run's bundle (its last block) or public copy (its hash): nothing signed, the run goes on. */
function skippedResult(
  behind: Extract<InFlight, { kind: "other" }>
): WriteContractResult {
  return {
    success: true,
    route: RUN_OUTCOME_OUTPUT.skippedInFlightRoute,
    included: false,
    ...("untilBlock" in behind
      ? { inFlightUntilBlock: behind.untilBlock }
      : { inFlightHash: behind.publicHash }),
  };
}

/**
 * This attempt's reservation takes the replayed row's key, so the cap counts
 * it with the crashed attempt's at that nonce, once (value-ledger).
 */
async function linkReplayReservation(
  write: BundleWrite,
  nonce: number
): Promise<void> {
  const reservationId = write.route.valueReservationId;
  if (!reservationId) {
    return;
  }
  try {
    await linkBundleReservation(reservationId, {
      chainId: write.chainId,
      walletAddress: write.walletAddress.toLowerCase(),
      nonce,
    });
  } catch (error) {
    // Unlinked, a held or settled reservation counts all day: the safe side.
    logSystemError(
      ErrorCategory.DATABASE,
      "[Bundle] Linking a replay's value reservation failed",
      error,
      { chain_id: String(write.chainId) }
    );
  }
}

/**
 * A replay of a step that already sent its bundle signs nothing: the landed
 * result when it was mined, the miss the step decided, its public copy
 * (landed, else pending with its hash), else not-checked (a later check
 * settles the run). Its reservation joins the crashed attempt's at the same
 * nonce, which counts it once whatever the result.
 */
async function replayResult(
  write: BundleWrite,
  replay: Extract<InFlight, { kind: "replay" }>,
  contractInterface: ethers.Interface
): Promise<WriteContractResult> {
  await linkReplayReservation(write, replay.nonce);
  const { landedHash, missed, publicHash } = replay;
  const { mode } = write.route;
  if (missed === "no-builder-accepted") {
    // A replay keeps no builders output: say so instead of pointing to it.
    return {
      success: false,
      error: `${NO_BUILDER_ACCEPTED} This step ran again after a crash and sent nothing new; the first attempt's builder answers are not kept.`,
      errorClass: OUTCOME_ERRORS[missed].errorClass,
      route: mode,
      included: false,
      broadcastAttempted: true,
    };
  }
  if (missed === "fallback-refused") {
    return fallbackRefusedResult(mode, {});
  }
  if (missed) {
    return notIncludedResult(mode, missed, {});
  }
  if (publicHash && !landedHash) {
    return await replayPublicCopy(write, publicHash, contractInterface);
  }
  if (landedHash) {
    try {
      const receipt = await write.rpcManager.executeWithFailover((provider) =>
        provider.getTransactionReceipt(landedHash)
      );
      if (receipt) {
        return await includedResult(
          write,
          { mined: minedOf(landedHash, receipt), gasLimit: null, report: {} },
          contractInterface
        );
      }
    } catch {
      // The row is confirmed: the sweep settles the run from it.
    }
  }
  return notIncludedResult(mode, "not-checked", {});
}

/** A replay whose public copy went out: landed when mined (a revert was paid), else pending on its hash. */
async function replayPublicCopy(
  write: BundleWrite,
  hash: string,
  contractInterface: ethers.Interface
): Promise<WriteContractResult> {
  try {
    const receipt = await write.rpcManager.executeWithFailover((provider) =>
      provider.getTransactionReceipt(hash)
    );
    if (receipt) {
      const mined = minedOf(hash, receipt);
      return await includedResult(
        write,
        {
          mined,
          gasLimit: null,
          report: {},
          ...(!mined.succeeded && { paidRevert: { lostRace: false } }),
        },
        contractInterface
      );
    }
  } catch {
    // Unreadable: pending, so the reconciler settles it from the hash.
  }
  return await publicPendingResult(write, hash, {});
}

async function inFlightResult(
  inFlight: InFlight,
  write: BundleWrite,
  contractInterface: ethers.Interface
): Promise<WriteContractResult | undefined> {
  if (inFlight.kind === "none") {
    return;
  }
  logInfo(
    inFlight.kind === "other"
      ? "[Bundle] Skipped: an earlier bundle of this workflow may still land"
      : "[Bundle] Replay of a step that already sent its bundle",
    {
      workflow_id: write.route.workflowId,
      chain_id: String(write.chainId),
    }
  );
  return inFlight.kind === "other"
    ? skippedResult(inFlight)
    : await replayResult(write, inFlight, contractInterface);
}

function checkInFlight(
  write: BundleWrite,
  sessionNonce?: number
): Promise<InFlight> {
  const { route, rpcManager } = write;
  return bundleInFlight({
    workflowId: route.workflowId,
    chainId: write.chainId,
    walletAddress: write.walletAddress,
    step: {
      executionId: route.executionId,
      nodeId: route.node.id,
      iterationIndex: route.node.iterationIndex,
    },
    readLatestBlock: () =>
      rpcManager.executeWithFailover((provider) => provider.getBlockNumber()),
    readMinedCount: () =>
      rpcManager.executeWithFailover((provider) =>
        provider.getTransactionCount(write.walletAddress, "latest")
      ),
    sessionNonce,
  });
}

type SessionEnd =
  | { done: WriteContractResult }
  | { replayOf: Extract<InFlight, { kind: "replay" }> }
  // The send threw after its public copy went out: its link is read after the lock.
  | { publicPending: { hash: string; report: Partial<BundleReport> } }
  | { outcome: BundleSendOutcome };

/** Refused before anything was signed or sent (run time left, Not before). */
function refusedUnsent(error: string): WriteContractResult {
  return {
    success: false,
    error,
    errorClass: ExecutionErrorType.USER,
    broadcastAttempted: false,
  };
}

/**
 * Send the call as a bundle: skip when this workflow's earlier bundle may
 * still land (checked again under the lock), wait while Not before is too far
 * ahead, else check gas and send inside the wallet's nonce session. Explorer
 * and trace lookups run after the lock.
 */
export async function writeAsBundle(
  write: BundleWrite
): Promise<WriteContractResult> {
  let contractInterface: ethers.Interface;
  let data: string;
  try {
    contractInterface = new ethers.Interface(
      write.parsedAbi as ethers.InterfaceAbi
    );
    data = contractInterface.encodeFunctionData(write.functionKey, write.args);
  } catch (error) {
    return {
      success: false,
      error: `Could not encode the call: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const early = await inFlightResult(
    await checkInFlight(write),
    write,
    contractInterface
  );
  if (early) {
    return early;
  }
  // After the replay check, so a replay whose templated Not before moved or cleared still returns its result.
  const { notBeforeRefusal } = write.route.settings;
  if (notBeforeRefusal) {
    return refusedUnsent(notBeforeRefusal);
  }
  const ahead = await waitingCheck(write);
  if ("done" in ahead) {
    return ahead.done;
  }
  // After the replay, in-flight and waiting checks: a base-fee spike fails only a step about to send.
  // Past the next block the in-session projection decides, and a cap below it waits.
  const { maxFeeOverride } = write.gas;
  if (maxFeeOverride !== undefined && !ahead.sendsAhead) {
    const capFailure = await maxFeeCapFailure(write.rpcManager, maxFeeOverride);
    if (capFailure) {
      return capFailure;
    }
  }

  const gasCheck = await preflightGasBalance({
    rpcManager: write.rpcManager,
    chainId: write.chainId,
    holderAddress: write.walletAddress,
    valueWei: write.value,
  });
  if (!gasCheck.affordable) {
    return { success: false, error: gasCheck.message };
  }

  // A run stopped inside the hold leaves the wallet held and nothing written.
  const runDeadline = runDeadlineAt();
  const tooLate = runTimeRefusal(runDeadline, STEP_HOLD);
  if (tooLate) {
    return refusedUnsent(tooLate);
  }

  let ended: SessionEnd;
  const waitStart = Date.now();
  try {
    ended = await sendInSession(write, contractInterface, data, runDeadline);
  } catch (error) {
    if (!(error instanceof NonceLockWaitEndedError)) {
      throw error;
    }
    return refusedUnsent(
      runDeadline === undefined
        ? error.message
        : walletBusyRefusal(runDeadline, Date.now() - waitStart)
    );
  }
  if ("done" in ended) {
    return ended.done;
  }
  if ("replayOf" in ended) {
    return await replayResult(write, ended.replayOf, contractInterface);
  }
  if ("publicPending" in ended) {
    const { hash, report } = ended.publicPending;
    return await publicPendingResult(write, hash, report);
  }
  return await resultOf(write, ended.outcome, contractInterface);
}

/** The wallet's nonce session: the lock wait ends where the run would run out of time. */
function sendInSession(
  write: BundleWrite,
  contractInterface: ethers.Interface,
  data: string,
  runDeadline: number | undefined
): Promise<SessionEnd> {
  const { route } = write;
  return withNonceSession(
    write.txContext,
    write.walletAddress,
    async (session): Promise<SessionEnd> => {
      // A row recorded while this step waited for the lock is seen only now.
      const inFlight = await checkInFlight(write, session.currentNonce);
      // A landed replay's receipt and trace are read after the lock.
      if (inFlight.kind === "replay" && inFlight.landedHash) {
        return { replayOf: inFlight };
      }
      const late = await inFlightResult(inFlight, write, contractInterface);
      if (late) {
        return { done: late };
      }
      let signer: ethers.Signer;
      try {
        signer = await initializeWalletSigner(
          write.organizationId,
          write.rpcUrl,
          write.chainId
        );
      } catch (error) {
        return {
          done: {
            success: false,
            error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
          },
        };
      }
      const progress: { sent: boolean; report?: BundleReport } = {
        sent: false,
      };
      try {
        const outcome = await sendBundleInSession({
          session,
          signer,
          rpcManager: write.rpcManager,
          chainId: write.chainId,
          triggerBlock: write.triggerBlock,
          call: {
            from: write.walletAddress,
            to: write.contractAddress,
            data,
            ...(write.value ? { value: write.value } : {}),
          },
          contractInterface,
          gas: write.gas,
          blocks: route.settings.blocks,
          tipIncreasePercent: route.settings.tipIncreasePercent,
          ...(route.settings.sendAhead && {
            sendAhead: route.settings.sendAhead,
          }),
          sendMode: route.mode,
          fallback: route.settings.fallback,
          builders: route.builders,
          unknownBuilders: route.unknownBuilders,
          searcher: route.searcher,
          workflowId: route.workflowId,
          node: route.node,
          valueReservationId: route.valueReservationId,
          runDeadline,
          progress,
        });
        return { outcome };
      } catch (error) {
        if (progress.sent) {
          // The send path never throws once sent; if it does, the row stays pending.
          logSystemError(
            ErrorCategory.WORKFLOW_ENGINE,
            "[Bundle] The bundle send threw after the row was recorded",
            error,
            { chain_id: String(write.chainId) }
          );
          const report: Partial<BundleReport> = progress.report ?? {};
          // A public copy may be in a pool: pending on its hash, never not-checked.
          const copy = report.publicCopy;
          if (copy && copy.accepted !== false) {
            return {
              publicPending: { hash: copy.hash, report },
            };
          }
          return {
            done: notIncludedResult(route.mode, "not-checked", report),
          };
        }
        return { done: failureOf(error, write, contractInterface) };
      }
    },
    runDeadline === undefined
      ? {}
      : {
          waitUntil:
            runDeadline - LONGEST_BUNDLE_HOLD_MS - BUNDLE_RUN_MARGIN_MS,
        }
  );
}
