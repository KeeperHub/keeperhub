/**
 * Aave V3 health-factor monitor workflow shape.
 *
 * Topology: Schedule trigger → read getUserAccountData → Condition (HF < threshold) → Email alert
 *
 * Requirements: PREFILL-01, PREFILL-03, PREFILL-04, PREFILL-05, SC#1
 *
 * No server-only import: the factory is pure deterministic TypeScript that
 * must be testable without a Next.js server context. Address constants are
 * inlined from lib/scan/adapters/protocol-registry.ts (same verified sources).
 */

import {
  buildConditionNode,
  buildEdge,
  buildEmailAlertNode,
  buildReadContractNode,
  buildScheduleTrigger,
  resolveAddressPrefill,
  resolveAmountPrefill,
} from "@/lib/scan/factory/node-builders";
import { hfThresholdRaw } from "@/lib/scan/suggestions/ranking";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Aave V3 Pool proxy addresses (inline copy — source of truth is
// lib/scan/adapters/protocol-registry.ts, which has server-only and cannot
// be imported here without breaking tests)
// ---------------------------------------------------------------------------

/**
 * Maps chainId → Aave V3 Pool proxy contract address.
 * Verification sources identical to protocol-registry.ts (bgd-labs/aave-address-book).
 */
const AAVE_V3_POOL_ADDRESSES: Readonly<Record<number, string>> = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Ethereum mainnet
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Arbitrum One
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Polygon
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Optimism
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Base
} as const;

// Inline copy of SparkLend Pool addresses (PREFILL-08).
// protocol-registry.ts has `import "server-only"` and cannot be imported here
// without breaking Vitest tests that run factory shapes in a plain Node context.
// [VERIFIED etherscan.io/address/0xC13e21B648A5Ee794902342038FF3aDAB66BE987 + docs.spark.fi 2026-06-29]
const SPARK_POOL_ADDRESSES: Readonly<Record<number, string>> = {
  1: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987", // Ethereum mainnet
} as const;

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for Aave V3 Pool getUserAccountData.
 * Sourced from lib/scan/abis/aave-v3-pool.json (verified 2026-06-16).
 * Embedded as a JSON string per web3/read-contract configField expectations.
 */
const GET_USER_ACCOUNT_DATA_ABI = JSON.stringify([
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Schedule defaults
// ---------------------------------------------------------------------------

/** Poll every 5 minutes — well above the 60s floor (PREFILL-05). */
const HF_MONITOR_CRON = "*/5 * * * *";

// ---------------------------------------------------------------------------
// Default HF threshold (1.5 → "1500000000000000000" in 1e18 units)
// ---------------------------------------------------------------------------

const DEFAULT_HF_THRESHOLD = 1.5;

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface HfMonitorOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the Aave V3 health-factor monitor workflow shape.
 *
 * Node IDs are derived from the descriptor slug for determinism (PREFILL-03).
 * config.network is set to String(chainId) on all web3 nodes (PREFILL-04).
 *
 * The condition uses a 1e18-scaled threshold string so the executor's BigInt
 * coercion logic (lib/bigint-condition-utils.ts) compares correctly against
 * the stringified-bigint healthFactor returned by getUserAccountData (SC#1).
 */
export function buildHfMonitor(
  descriptor: SuggestionDescriptor
): HfMonitorOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  const isSpark = descriptor.protocol === "spark";
  const poolAddresses = isSpark ? SPARK_POOL_ADDRESSES : AAVE_V3_POOL_ADDRESSES;
  const poolAddress = poolAddresses[descriptor.chainId];
  if (!poolAddress) {
    throw new Error(
      `No ${isSpark ? "Spark" : "Aave V3"} Pool address for chainId ${descriptor.chainId}.`
    );
  }

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  // Read node label/description are protocol-specific and single-sourced into
  // hfRef so the template ref in the condition leftOperand stays in sync with
  // the actual node label (T-56-07 / PREFILL-08).
  const readLabel = isSpark ? "Read Spark Health Factor" : "Read Health Factor";
  const readDescription = isSpark
    ? "Read SparkLend getUserAccountData"
    : "Read Aave V3 getUserAccountData";

  // Template ref for the healthFactor output field — derives from readLabel
  // so that validateTemplateRefs can resolve it against the read node.
  const hfRef = `{{@${readId}:${readLabel}.result.healthFactor}}`;

  // Threshold in Aave's 1e18 base units.
  // Prefer the clamped value pre-computed by the engine (confirmInputs.threshold),
  // which is the same value shown in the description (WR-01). resolveAmountPrefill
  // enforces the ^\d+$ base-unit shape (same guard as the sibling shapes): a
  // human-scale value like "1.5" from a crafted or drifted descriptor would
  // otherwise become a BigInt-vs-float condition that silently never fires.
  // Falls back to the module default for descriptors lacking the key or
  // carrying a non-base-unit value (e.g. hand-written test fixtures).
  const thresholdStr = resolveAmountPrefill(
    descriptor.confirmInputs.threshold,
    hfThresholdRaw(DEFAULT_HF_THRESHOLD)
  );

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: HF_MONITOR_CRON }, 0),
    buildReadContractNode(
      readId,
      {
        label: readLabel,
        description: readDescription,
        network,
        contractAddress: poolAddress,
        abi: GET_USER_ACCOUNT_DATA_ABI,
        abiFunction: "getUserAccountData",
        // Real scanned address when the engine prefilled it; placeholder otherwise
        functionArgs: JSON.stringify([
          resolveAddressPrefill(
            descriptor.confirmInputs.walletAddress,
            "{{walletAddress}}"
          ),
        ]),
      },
      1
    ),
    buildConditionNode(
      conditionId,
      {
        label: "HF Below Alert Threshold",
        slug,
        leftOperand: hfRef,
        operator: "<",
        rightOperand: thresholdStr,
      },
      2
    ),
    buildEmailAlertNode(
      alertId,
      {
        label: "Send Alert",
        subject: "KeeperHub alert: health factor below threshold",
        bodyTemplate: `Health factor below threshold: ${hfRef}`,
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when HF < threshold
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
