/**
 * Send as Bundle for Write Contract: the checks before anything is sent, the
 * in-flight skip, and the send inside the wallet's nonce session. Not a step file.
 */
import "server-only";

import { ethers } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
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
  sendBundleInSession,
} from "@/lib/web3/bundles/send-bundle";
import {
  type BundleSettings,
  type BundleSettingsInput,
  readBundleSettings,
} from "@/lib/web3/bundles/settings";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { GasOverrides } from "@/lib/web3/chain-adapter/types";
import {
  classifyRevert,
  formatContractError,
} from "@/lib/web3/decode-revert-error";
import { buildErrorDecodeInterface } from "@/lib/web3/extra-error-abis";
import { preflightGasBalance } from "@/lib/web3/gas-preflight";
import type { TriggerBlock } from "@/lib/web3/next-block-limits";
import {
  getNextBlockSimulation,
  isNextBlockSimulationUnsupported,
} from "@/lib/web3/next-block-simulation";
import { minedRevertError } from "@/lib/web3/onchain-revert";
import {
  BUNDLE_SAFE_REFUSAL,
  SEND_MODE,
  USE_NORMAL_HINT,
} from "@/lib/web3/send-mode";
import type { ExecutedCall } from "@/lib/web3/trace-decode";
import type { TraceExecutedCallOptions } from "@/lib/web3/trace-executed-call";
import { NonceLockWaitEndedError } from "@/lib/web3/nonce-manager";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import { initializeWalletSigner } from "@/lib/web3/wallet-helpers";
import {
  BUNDLE_ROUTE,
  BUNDLE_STEP_ACTION_TYPES,
  RUN_OUTCOME_OUTPUT,
} from "@/lib/workflow/executor/run-outcome-keys";
import { runDeadlineAt } from "@/lib/workflow/executor/runner-constants";
import type {
  WriteContractCoreInput,
  WriteContractResult,
} from "./write-contract-core";

type Failure = Extract<WriteContractResult, { success: false }>;

const SET_TO_BUNDLE = 'This step is set to Send as: Bundle (sendMode: "bundle"), but';

/** The step context a bundle needs: a workflow run of a Write Contract node. */
type BundleStepContext = NonNullable<WriteContractCoreInput["_context"]>;

/** Everything checked before the wallet is touched. */
export type BundleRoute = {
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
  config: BundleSettingsInput;
}): Promise<
  { ok: true; route: BundleRoute } | { ok: false; failure: Failure }
> {
  if (!isBundleSendEnabledForOrg(options.organizationId)) {
    return userFailure(
      `${SET_TO_BUNDLE} bundles are not enabled for this organization. ${USE_NORMAL_HINT}`
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
      `${SET_TO_BUNDLE} bundles only run in a Write Contract step of a workflow, not from a direct API or MCP call. ${USE_NORMAL_HINT}`
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
  const available = await loadChainBuilders(options.chainId);
  if (available.length === 0) {
    return userFailure(
      `${SET_TO_BUNDLE} this network has no block builders to send bundles to. ${USE_NORMAL_HINT}`
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
        error: `${SET_TO_BUNDLE} bundles are not set up on this server, so nothing was sent. ${USE_NORMAL_HINT}`,
        errorClass: ExecutionErrorType.SYSTEM,
      },
    };
  }
  return {
    ok: true,
    route: {
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
  signerMode: SignerMode
): Failure | undefined {
  if (signerMode.kind === SIGNER_MODE.EOA) {
    return;
  }
  return {
    success: false,
    error: BUNDLE_SAFE_REFUSAL,
    errorClass: ExecutionErrorType.USER,
  };
}

/** The bundle output keys of a result, for a softened failure to keep. */
export function bundleOutputsOf(
  result: WriteContractResult
): Partial<BundleReport> {
  const { targetBlocks, targetTipsGwei, builders, bundleTargetsSkipped } =
    result;
  return {
    ...(targetBlocks && { targetBlocks }),
    ...(targetTipsGwei && { targetTipsGwei }),
    ...(builders && { builders }),
    ...(bundleTargetsSkipped && { bundleTargetsSkipped }),
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

async function includedResult(
  write: BundleWrite,
  outcome: {
    mined: MinedHash;
    gasLimit: bigint | null;
    report: Partial<BundleReport>;
  },
  contractInterface: ethers.Interface | undefined
): Promise<WriteContractResult> {
  const { mined, report } = outcome;
  const transactionLink = await linkOf(write.chainId, mined.hash);
  const sent = {
    route: BUNDLE_ROUTE,
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
    return {
      success: false,
      error: formatContractError(
        error,
        buildErrorDecodeInterface(contractInterface, write.errorAbis)
      ),
      broadcastAttempted: true,
      ...sent,
    };
  }
  const gasUnits = mined.gasUnits ?? BigInt(0);
  const fee = mined.feeWei ?? BigInt(0);
  const executedCall = await write.traceExecuted(mined.hash, {
    target: write.contractAddress,
    abi: write.parsedAbi,
    functionName: write.abiFunction,
  });
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
  reason: NotIncludedReason,
  report: Partial<BundleReport>
): WriteContractResult {
  return {
    success: true,
    route: BUNDLE_ROUTE,
    included: false,
    [RUN_OUTCOME_OUTPUT.notIncludedReasonKey]: reason,
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
      return notIncludedResult(outcome.reason, outcome.report);
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
        route: BUNDLE_ROUTE,
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
      error: `${SET_TO_BUNDLE} this network's RPC cannot simulate the target blocks, which a bundle needs. Use an RPC that supports it, or set Send as to Normal transaction (sendMode: "${SEND_MODE.TRANSACTION}").`,
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

/** Skipped behind another run's bundle: nothing signed, the run goes on. */
function skippedResult(untilBlock: number): WriteContractResult {
  return {
    success: true,
    route: RUN_OUTCOME_OUTPUT.skippedInFlightRoute,
    included: false,
    inFlightUntilBlock: untilBlock,
  };
}

/**
 * A replay of a step that already sent its bundle signs nothing: the landed
 * result when it was mined, the miss the step decided, else not-checked (a
 * later check settles the run). Landed and not-checked keep this attempt's
 * value charge, as the crashed one's lapses; a decided miss releases it.
 */
async function replayResult(
  write: BundleWrite,
  replay: Extract<InFlight, { kind: "replay" }>,
  contractInterface: ethers.Interface
): Promise<WriteContractResult> {
  const { landedHash, missed } = replay;
  if (missed === "no-builder-accepted") {
    // A replay keeps no builders output: say so instead of pointing to it.
    return {
      success: false,
      error: `${NO_BUILDER_ACCEPTED} This step ran again after a crash and sent nothing new; the first attempt's builder answers are not kept.`,
      errorClass: OUTCOME_ERRORS[missed].errorClass,
      route: BUNDLE_ROUTE,
      included: false,
      broadcastAttempted: true,
    };
  }
  if (missed) {
    return notIncludedResult(missed, {});
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
  return notIncludedResult("not-checked", {});
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
    ? skippedResult(inFlight.untilBlock)
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
    sessionNonce,
  });
}

type SessionEnd =
  | { done: WriteContractResult }
  | { replayOf: string }
  | { outcome: BundleSendOutcome };

/** Refused for the run's time left: nothing was signed or sent. */
function outOfRunTime(error: string): WriteContractResult {
  return {
    success: false,
    error,
    errorClass: ExecutionErrorType.USER,
    broadcastAttempted: false,
  };
}

/**
 * Send the call as a bundle: skip when this workflow's earlier bundle may
 * still land (checked again under the lock), else check gas and send inside
 * the wallet's nonce session. Explorer and trace lookups run after the lock.
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
  const tooLate = runTimeRefusal(runDeadline, LONGEST_BUNDLE_HOLD_MS);
  if (tooLate) {
    return outOfRunTime(tooLate);
  }

  let ended: SessionEnd;
  try {
    ended = await sendInSession(write, contractInterface, data, runDeadline);
  } catch (error) {
    if (!(error instanceof NonceLockWaitEndedError)) {
      throw error;
    }
    return outOfRunTime(
      runTimeRefusal(runDeadline, LONGEST_BUNDLE_HOLD_MS) ?? error.message
    );
  }
  if ("done" in ended) {
    return ended.done;
  }
  if ("replayOf" in ended) {
    return await replayResult(
      write,
      { kind: "replay", landedHash: ended.replayOf },
      contractInterface
    );
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
        return { replayOf: inFlight.landedHash };
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
          return {
            done: notIncludedResult("not-checked", progress.report ?? {}),
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
