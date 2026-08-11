/**
 * Stablecoin depeg watch workflow shape.
 *
 * Topology: Schedule trigger -> read-contract (Chainlink latestRoundData) ->
 * Condition (answer < $0.995 at 8 decimals) -> Email alert
 *
 * Market-level monitor: reads the stablecoin's Chainlink USD feed directly,
 * so no wallet address is involved. Read-only (PREFILL-06).
 *
 * Requirements: PREFILL-01, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06
 */

import {
  buildConditionNode,
  buildEdge,
  buildEmailAlertNode,
  buildReadContractNode,
  buildScheduleTrigger,
} from "@/lib/scan/factory/node-builders";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Verified feed addresses
// ---------------------------------------------------------------------------

/**
 * Chainlink USD aggregator proxies per chainId and symbol.
 *
 * Inline copy from lib/scan/adapters/protocol-registry.ts
 * STABLECOIN_CHAINLINK_FEEDS (the registry is server-only; factory shapes
 * must stay client/test safe). Only Ethereum mainnet feeds are verified.
 *
 * [VERIFIED reference-data-directory.vercel.app feeds-mainnet.json 2026-06-16]
 *
 * The engine only emits depeg-watch descriptors for (symbol, chainId) pairs
 * present here, so the two copies stay behaviorally in sync via the factory
 * contract test (engine descriptor -> buildWorkflow must not throw).
 */
export const DEPEG_WATCH_FEEDS: Record<number, Record<string, string>> = {
  1: {
    USDC: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    USDT: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll every 15 minutes — well above the 60s floor (PREFILL-05). */
const DEPEG_WATCH_CRON = "*/15 * * * *";

/**
 * $0.995 at Chainlink's 8-decimal scale. Mirrors DEPEG_THRESHOLD (0.5%)
 * from lib/scan/price/chainlink.ts on the downside only — the downside is
 * the loss-of-peg direction that threatens holders.
 */
const DEPEG_THRESHOLD_RAW = "99500000";

/**
 * latestRoundData fragment, embedded as a JSON string per web3/read-contract
 * configField expectations (same pattern as hf-monitor's ABI constant).
 */
const LATEST_ROUND_DATA_ABI = JSON.stringify([
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface DepegWatchOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the stablecoin depeg watch workflow shape.
 *
 * The descriptor is expected to carry:
 *   - chainId + symbol matching a DEPEG_WATCH_FEEDS entry (the engine only
 *     emits descriptors for covered pairs; anything else throws here so the
 *     factory guard tests catch drift).
 */
export function buildDepegWatch(
  descriptor: SuggestionDescriptor
): DepegWatchOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);
  const symbol = descriptor.symbol;
  const feedAddress = symbol
    ? DEPEG_WATCH_FEEDS[descriptor.chainId]?.[symbol]
    : undefined;
  if (!(symbol && feedAddress)) {
    throw new Error(
      `No Chainlink feed for depeg watch (symbol: ${symbol ?? "?"}, chainId: ${descriptor.chainId}).`
    );
  }

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  const readLabel = "Read Chainlink Price";
  const answerRef = `{{@${readId}:${readLabel}.result.answer}}`;

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: DEPEG_WATCH_CRON }, 0),
    buildReadContractNode(
      readId,
      {
        label: readLabel,
        description: `Chainlink ${symbol}/USD latestRoundData`,
        network,
        contractAddress: feedAddress,
        abi: LATEST_ROUND_DATA_ABI,
        abiFunction: "latestRoundData",
        functionArgs: "[]",
      },
      1
    ),
    buildConditionNode(
      conditionId,
      {
        label: "Price Below Peg Threshold",
        slug,
        leftOperand: answerRef,
        operator: "<",
        rightOperand: DEPEG_THRESHOLD_RAW,
      },
      2
    ),
    buildEmailAlertNode(
      alertId,
      {
        label: "Send Depeg Alert",
        subject: `KeeperHub alert: ${symbol} depeg`,
        bodyTemplate:
          `${symbol} Chainlink price fell below $0.995. ` +
          `Raw 8-decimal price: ${answerRef}.`,
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when price < peg threshold
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
