import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainByChainId } from "@/lib/rpc/chain-service";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  type EventTriggerTarget,
  resolveTriggerChainId,
  runEventTriggerStaticChecks,
} from "./event-trigger-checks";
import type {
  EventTriggerConfig,
  EventTriggerPreviewFinding,
  EventTriggerPreviewMatch,
  EventTriggerPreviewResult,
  EventTriggerPreviewScan,
  EventTriggerPreviewVerdict,
} from "./types";

/** Blocks scanned when the caller names no window. */
export const DEFAULT_LOOKBACK_BLOCKS = 5000;
/** Ceiling on the requested window, so one preview cannot become a long scan. */
export const MAX_LOOKBACK_BLOCKS = 50_000;
/**
 * Blocks per `eth_getLogs` call. Matches the batch size `web3/query-events`
 * uses, which is the size this deployment's upstreams are known to accept.
 */
const SCAN_CHUNK_BLOCKS = 2000;
/**
 * Logs read before the scan stops early. A trigger this busy has already
 * answered the question the preview exists to ask, and the rate is computed
 * from the blocks actually scanned so an early stop does not inflate it.
 */
const MAX_LOGS_SCANNED = 5000;
/** Decoded matches returned with the result. */
export const MAX_PREVIEW_SAMPLES = 5;
/** Fires per day at or above which the trigger is called out as high volume. */
export const HIGH_VOLUME_FIRES_PER_DAY = 500;

const SECONDS_PER_DAY = 86_400;

export type WorkflowTriggerPreviewNode = {
  id: string;
  type?: string;
  data?: {
    type?: string;
    config?: Record<string, unknown>;
  };
};

export type RunEventTriggerPreviewInput = {
  nodes: WorkflowTriggerPreviewNode[];
  /** Applied to RPC endpoint selection, matching how workflow reads resolve it. */
  userId?: string;
  lookbackBlocks?: number;
  /**
   * Epoch milliseconds after which the scan stops early and reports what it
   * covered. A wide window on a slow upstream is many sequential `eth_getLogs`
   * calls, and a partial answer is worth more to the caller than an open
   * request. The first chunk always runs, so the result is never empty for
   * want of time alone.
   */
  deadlineAt?: number;
};

function finding(
  code: EventTriggerPreviewFinding["code"],
  severity: EventTriggerPreviewFinding["severity"],
  message: string
): EventTriggerPreviewFinding {
  return { code, severity, message };
}

/**
 * The result shape for a preview that stopped before scanning.
 *
 * `matchCount` and the counters stay null rather than zero: nothing was
 * counted, and a zero here would read as "scanned and found none".
 */
function notScanned(
  verdict: EventTriggerPreviewVerdict,
  summary: string,
  findings: EventTriggerPreviewFinding[]
): EventTriggerPreviewResult {
  return {
    verdict,
    summary,
    findings,
    scan: null,
    matchCount: null,
    filteredOutCount: null,
    estimatedFiresPerDay: null,
    samples: [],
  };
}

function findTriggerNode(
  nodes: WorkflowTriggerPreviewNode[]
): WorkflowTriggerPreviewNode | null {
  return (
    nodes.find(
      (node) => node.type === "trigger" || node.data?.type === "trigger"
    ) ?? null
  );
}

function clampLookback(requested: number | undefined): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return DEFAULT_LOOKBACK_BLOCKS;
  }
  return Math.min(Math.floor(requested), MAX_LOOKBACK_BLOCKS);
}

/**
 * Render a decoded argument as JSON-safe data.
 *
 * The conversion has to be recursive, not just top-level: a `uint256[]` or a
 * tuple decodes to a Result holding bigints, and one of those reaching
 * `NextResponse.json` throws "Do not know how to serialize a BigInt" and
 * turns a preview into a 500. Same approach as `web3/query-events`.
 */
function serializeBigInts(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString() : entry
    )
  );
}

function serializeArgs(parsed: ethers.LogDescription): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const [index, input] of parsed.fragment.inputs.entries()) {
    args[input.name || `arg${index}`] = serializeBigInts(parsed.args[index]);
  }

  return args;
}

/**
 * The post-decode filters the payment trigger carries.
 *
 * Mirrors `paymentEventMatches` in the event tracker: an unset filter matches
 * everything, a set one compares case-insensitively against the decoded
 * argument and rejects a non-string value.
 */
function passesDecodedFilters(
  parsed: ethers.LogDescription,
  target: EventTriggerTarget
): boolean {
  return (
    argMatches(parsed.args?.to, target.recipientFilter) &&
    argMatches(parsed.args?.memo, target.memoFilter)
  );
}

function argMatches(value: unknown, filter: string | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return value.toLowerCase() === filter.toLowerCase();
}

type ScanWindow = { fromBlock: number; toBlock: number };

/**
 * Why a scan stopped, which the caller reports differently.
 *
 * `log-ceiling` is a statement about the trigger: it is emitting more than the
 * preview will count. `deadline` is a statement about the request: the window
 * was wider than the time budget. Conflating them would report a slow chain as
 * a busy trigger.
 */
type ScanStopReason = "complete" | "log-ceiling" | "deadline";

type RawScan = {
  window: ScanWindow;
  logs: ethers.Log[];
  stopReason: ScanStopReason;
  /** The last block actually covered, which is what the rate is computed over. */
  scannedThrough: number;
};

/**
 * Read matching logs in bounded chunks.
 *
 * Every call goes through `executeWithFailover` so a primary-RPC blip falls
 * over to the chain's fallback, the same routing the workflow's own reads use.
 *
 * `stopAfter` is how many logs are enough for the caller's question. The
 * counting scan wants the ceiling; the existence probe wants one, and stopping
 * there is what keeps it from reading thousands of unrelated logs off a busy
 * contract to answer a yes-or-no question.
 */
async function scanLogs(
  rpc: RpcProviderManager,
  address: string,
  topics: (string | null)[],
  window: ScanWindow,
  options: { deadlineAt?: number; stopAfter?: number } = {}
): Promise<RawScan> {
  const stopAfter = options.stopAfter ?? MAX_LOGS_SCANNED;
  const logs: ethers.Log[] = [];
  let scannedThrough = window.fromBlock - 1;

  for (
    let start = window.fromBlock;
    start <= window.toBlock;
    start += SCAN_CHUNK_BLOCKS
  ) {
    // Checked before the call rather than after, so the budget bounds when the
    // last request is issued rather than when it returns.
    if (
      options.deadlineAt !== undefined &&
      Date.now() >= options.deadlineAt &&
      start > window.fromBlock
    ) {
      return { window, logs, stopReason: "deadline", scannedThrough };
    }

    const end = Math.min(start + SCAN_CHUNK_BLOCKS - 1, window.toBlock);

    const chunk = await rpc.executeWithFailover((provider) =>
      provider.getLogs({ address, topics, fromBlock: start, toBlock: end })
    );

    logs.push(...chunk);
    scannedThrough = end;

    if (logs.length >= stopAfter) {
      return {
        window,
        logs,
        stopReason: end < window.toBlock ? "log-ceiling" : "complete",
        scannedThrough,
      };
    }
  }

  return { window, logs, stopReason: "complete", scannedThrough };
}

/**
 * Seconds between two block timestamps, or null when either cannot be read.
 *
 * Best-effort on purpose: a missing timestamp costs the rate estimate, not
 * the preview.
 */
async function measureSpanSeconds(
  rpc: RpcProviderManager,
  fromBlock: number,
  toBlock: number
): Promise<number | null> {
  try {
    const [first, last] = await Promise.all([
      rpc.executeWithFailover((provider) => provider.getBlock(fromBlock)),
      rpc.executeWithFailover((provider) => provider.getBlock(toBlock)),
    ]);

    if (!(first && last)) {
      return null;
    }

    const span = last.timestamp - first.timestamp;
    return span > 0 ? span : null;
  } catch {
    return null;
  }
}

type DecodedLogs = {
  matches: EventTriggerPreviewMatch[];
  matchCount: number;
  filteredOutCount: number;
};

/**
 * Decode logs that matched topic0 and apply the trigger's own match rules.
 *
 * The listener re-checks the decoded event name after parsing, so a log whose
 * topic0 collides with a different event in the same ABI is not a match. The
 * same check is applied here.
 */
function decodeLogs(
  logs: ethers.Log[],
  iface: ethers.Interface,
  target: EventTriggerTarget
): DecodedLogs {
  const matches: EventTriggerPreviewMatch[] = [];
  let matchCount = 0;
  let filteredOutCount = 0;

  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }

    if (!parsed || parsed.name !== target.eventName) {
      continue;
    }

    if (passesDecodedFilters(parsed, target)) {
      matchCount += 1;
      matches.push({
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
        args: serializeArgs(parsed),
      });
    } else {
      filteredOutCount += 1;
    }
  }

  matches.sort((a, b) => b.blockNumber - a.blockNumber);

  return {
    matches: matches.slice(0, MAX_PREVIEW_SAMPLES),
    matchCount,
    filteredOutCount,
  };
}

function estimateFiresPerDay(
  matchCount: number,
  spanSeconds: number | null
): number | null {
  if (spanSeconds === null || spanSeconds <= 0) {
    return null;
  }
  const perDay = (matchCount * SECONDS_PER_DAY) / spanSeconds;
  return Math.round(perDay * 10) / 10;
}

/**
 * Explain a window that produced no match.
 *
 * A quiet contract and a misconfigured one look identical from an empty
 * result, so the distinguishing probe is a second read over the same window
 * with no topic filter: if the contract emitted anything at all, the wiring
 * reaches a live contract and the event is merely rare.
 */
async function explainEmptyWindow(
  rpc: RpcProviderManager,
  target: EventTriggerTarget,
  window: ScanWindow,
  deadlineAt: number | undefined
): Promise<EventTriggerPreviewFinding> {
  try {
    // One log is the whole answer, so the probe stops at the first chunk that
    // finds any rather than counting them off a busy contract.
    const anyEvent = await scanLogs(rpc, target.contractAddress, [], window, {
      stopAfter: 1,
      deadlineAt,
    });

    if (anyEvent.logs.length > 0) {
      return finding(
        "NO_MATCHES_CONTRACT_ACTIVE",
        "info",
        `The contract emitted other events in this window but no ${target.eventName}. The trigger is wired to a live contract; this event is simply rarer than the window is wide.`
      );
    }
  } catch {
    // Fall through to the weaker claim: the probe is a nicety, not a
    // requirement, and its failure must not fail the preview.
  }

  return finding(
    "NO_MATCHES_CONTRACT_SILENT",
    "warning",
    "The contract emitted no events at all in this window. Widen the window, or check that the address and network are the ones you meant."
  );
}

type VerdictInput = {
  target: EventTriggerTarget;
  matchCount: number;
  filteredOutCount: number;
  estimatedPerDay: number | null;
  stopReason: ScanStopReason;
};

function buildScanFindings(input: VerdictInput): EventTriggerPreviewFinding[] {
  const findings: EventTriggerPreviewFinding[] = [];

  if (input.stopReason === "log-ceiling") {
    findings.push(
      finding(
        "HIGH_VOLUME",
        "warning",
        `This event was emitted at least ${MAX_LOGS_SCANNED} times before the scan reached its ceiling and stopped. Each match is a billed workflow run. The rate below is measured over the blocks actually scanned, not the window requested.`
      )
    );
  }

  if (input.stopReason === "deadline") {
    findings.push(
      finding(
        "SCAN_TRUNCATED",
        "info",
        "The scan reached its time limit before covering the whole window. Every count below is over the blocks actually scanned. Ask for a narrower window for a complete answer."
      )
    );
  }

  if (input.matchCount === 0 && input.filteredOutCount > 0) {
    findings.push(
      finding(
        "FILTERS_EXCLUDED_EVERY_MATCH",
        "warning",
        `${input.filteredOutCount} ${input.target.eventName} event${input.filteredOutCount === 1 ? "" : "s"} were emitted, but every one was excluded by the recipient or memo filter.`
      )
    );
  }

  if (
    input.estimatedPerDay !== null &&
    input.estimatedPerDay >= HIGH_VOLUME_FIRES_PER_DAY &&
    input.stopReason !== "log-ceiling"
  ) {
    findings.push(
      finding(
        "HIGH_VOLUME",
        "warning",
        `At this rate the trigger would start roughly ${input.estimatedPerDay} executions per day. Each one is a billed workflow run.`
      )
    );
  }

  return findings;
}

function scanVerdict(input: VerdictInput): {
  verdict: EventTriggerPreviewVerdict;
  summary: string;
} {
  if (input.matchCount === 0) {
    return {
      verdict: "no-recent-matches",
      summary: `No ${input.target.eventName} event matched in the scanned window.`,
    };
  }

  const rate =
    input.estimatedPerDay === null
      ? ""
      : `, about ${input.estimatedPerDay} per day`;

  if (
    input.stopReason === "log-ceiling" ||
    (input.estimatedPerDay !== null &&
      input.estimatedPerDay >= HIGH_VOLUME_FIRES_PER_DAY)
  ) {
    return {
      verdict: "high-volume",
      summary: `${input.matchCount} ${input.target.eventName} event${input.matchCount === 1 ? "" : "s"} matched${rate}. This trigger would run often enough to be worth a cost check.`,
    };
  }

  return {
    verdict: "ok",
    summary: `${input.matchCount} ${input.target.eventName} event${input.matchCount === 1 ? "" : "s"} matched${rate}.`,
  };
}

async function previewTarget(
  target: EventTriggerTarget,
  iface: ethers.Interface,
  rpc: RpcProviderManager,
  lookbackBlocks: number,
  deadlineAt: number | undefined
): Promise<EventTriggerPreviewResult> {
  // Independent reads, so they go together: the window does not depend on the
  // code and the code does not depend on the window.
  const [head, code] = await Promise.all([
    rpc.executeWithFailover((provider) => provider.getBlockNumber()),
    rpc.executeWithFailover((provider) =>
      provider.getCode(target.contractAddress)
    ),
  ]);

  const window: ScanWindow = {
    fromBlock: Math.max(0, head - lookbackBlocks),
    toBlock: head,
  };

  if (code === "0x") {
    return notScanned(
      "will-never-fire",
      "There is no contract at this address on this network.",
      [
        finding(
          "CONTRACT_HAS_NO_CODE",
          "blocking",
          `${target.contractAddress} holds no contract code on chain ${target.chainId}. This is usually the right address on the wrong network, or a typo.`
        ),
      ]
    );
  }

  const raw = await scanLogs(
    rpc,
    target.contractAddress,
    [target.topic0],
    window,
    { deadlineAt }
  );
  const decoded = decodeLogs(raw.logs, iface, target);

  const scannedWindow: ScanWindow = {
    fromBlock: window.fromBlock,
    toBlock: raw.scannedThrough,
  };
  const spanSeconds = await measureSpanSeconds(
    rpc,
    scannedWindow.fromBlock,
    scannedWindow.toBlock
  );
  const estimatedPerDay = estimateFiresPerDay(decoded.matchCount, spanSeconds);

  const verdictInput: VerdictInput = {
    target,
    matchCount: decoded.matchCount,
    filteredOutCount: decoded.filteredOutCount,
    estimatedPerDay,
    stopReason: raw.stopReason,
  };

  const findings = buildScanFindings(verdictInput);

  if (decoded.matchCount === 0 && decoded.filteredOutCount === 0) {
    findings.push(
      await explainEmptyWindow(rpc, target, scannedWindow, deadlineAt)
    );
  }

  const scan: EventTriggerPreviewScan = {
    fromBlock: scannedWindow.fromBlock,
    toBlock: scannedWindow.toBlock,
    blocksScanned: scannedWindow.toBlock - scannedWindow.fromBlock + 1,
    spanSeconds,
  };

  const { verdict, summary } = scanVerdict(verdictInput);

  return {
    verdict,
    summary,
    findings,
    scan,
    matchCount: decoded.matchCount,
    filteredOutCount: decoded.filteredOutCount,
    estimatedFiresPerDay: estimatedPerDay,
    samples: decoded.matches,
  };
}

/**
 * Preview an Event trigger against recent chain history.
 *
 * Read-only by construction: it signs nothing, creates no execution record,
 * reserves no spending limit and performs no billing operation. Every finding
 * is advisory - a preview never blocks enabling a workflow.
 */
export async function runEventTriggerPreview(
  input: RunEventTriggerPreviewInput
): Promise<EventTriggerPreviewResult> {
  const triggerNode = findTriggerNode(input.nodes);

  if (!triggerNode) {
    return notScanned("will-never-fire", "This workflow has no trigger node.", [
      finding(
        "TRIGGER_NODE_MISSING",
        "blocking",
        "No node in this workflow is a trigger, so nothing can start it."
      ),
    ]);
  }

  const config = (triggerNode.data?.config ?? {}) as EventTriggerConfig;
  const triggerType =
    typeof config.triggerType === "string" ? config.triggerType : "unset";

  if (triggerType !== "Event") {
    return notScanned(
      "unknown",
      `Preview covers Event triggers. This workflow uses a ${triggerType} trigger.`,
      [
        finding(
          "TRIGGER_TYPE_NOT_EVENT",
          "info",
          `This trigger is of type "${triggerType}". Only Event triggers can be previewed against chain history.`
        ),
      ]
    );
  }

  const chainIdResult = resolveTriggerChainId(config);
  if ("finding" in chainIdResult) {
    return notScanned("will-never-fire", chainIdResult.finding.message, [
      chainIdResult.finding,
    ]);
  }

  const chain = await getChainByChainId(chainIdResult.chainId);
  const staticResult = runEventTriggerStaticChecks({
    config,
    chainId: chainIdResult.chainId,
    chain,
  });

  if (!staticResult.target) {
    return notScanned(
      "will-never-fire",
      staticResult.findings[0]?.message ??
        "This trigger cannot be registered as configured.",
      staticResult.findings
    );
  }

  const target = staticResult.target;
  const iface = new ethers.Interface(target.eventFragments);

  try {
    const rpc = await getRpcProvider({
      chainId: target.chainId,
      userId: input.userId,
    });

    return await previewTarget(
      target,
      iface,
      rpc,
      clampLookback(input.lookbackBlocks),
      input.deadlineAt
    );
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Trigger Preview] Chain scan unavailable",
      error,
      { chainId: String(target.chainId) }
    );

    return notScanned(
      "unknown",
      "The trigger configuration is sound, but chain history could not be read just now.",
      [
        finding(
          "SCAN_UNAVAILABLE",
          "info",
          "Every configuration check passed. The chain could not be reached to count recent matches, so nothing is claimed about how often this trigger fires."
        ),
      ]
    );
  }
}
