/**
 * Gas balance alert workflow shape.
 *
 * Topology: Schedule trigger -> check-balance (native) ->
 * Condition (balanceWei < threshold) -> Email alert
 *
 * Alerts when the wallet's native gas balance runs low on a chain the user
 * is active on, so scheduled transactions and manual operations do not start
 * failing for lack of gas. Read-only (PREFILL-06).
 *
 * Requirements: PREFILL-01, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06
 */

import {
  buildCheckBalanceNode,
  buildConditionNode,
  buildEdge,
  buildEmailAlertNode,
  buildScheduleTrigger,
  resolveAddressPrefill,
  resolveAmountPrefill,
} from "@/lib/scan/factory/node-builders";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll hourly — gas balances drain slowly (PREFILL-05). */
const GAS_BALANCE_CRON = "0 * * * *";

/** Default low-gas threshold: 0.01 native token in wei. */
const DEFAULT_GAS_THRESHOLD_WEI = "10000000000000000";

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface GasBalanceOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the gas balance alert workflow shape.
 *
 * The descriptor is expected to carry:
 *   - chainId: number
 *   - confirmInputs.walletAddress: scanned address (engine prefill)
 *   - confirmInputs.gasThreshold: wei threshold (engine prefill; falls back
 *     to 0.01 native for hand-written descriptors)
 */
export function buildGasBalance(
  descriptor: SuggestionDescriptor
): GasBalanceOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  const readLabel = "Get Native Balance";
  // check-balance output fields are flat (balance, balanceWei) — see
  // plugins/web3/index.ts outputFields for check-balance.
  const balanceRef = `{{@${readId}:${readLabel}.balanceWei}}`;

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: GAS_BALANCE_CRON }, 0),
    buildCheckBalanceNode(
      readId,
      {
        label: readLabel,
        network,
        // Real scanned address when the engine prefilled it; placeholder otherwise
        address: resolveAddressPrefill(
          descriptor.confirmInputs.walletAddress,
          "{{walletAddress}}"
        ),
      },
      1
    ),
    buildConditionNode(
      conditionId,
      {
        label: "Balance Below Threshold",
        slug,
        leftOperand: balanceRef,
        operator: "<",
        rightOperand: resolveAmountPrefill(
          descriptor.confirmInputs.gasThreshold,
          DEFAULT_GAS_THRESHOLD_WEI
        ),
      },
      2
    ),
    buildEmailAlertNode(
      alertId,
      {
        label: "Send Balance Alert",
        subject: "KeeperHub alert: low native token balance",
        bodyTemplate:
          "Native token balance is running low. " +
          `Current balance: ${balanceRef} wei. Top up to keep transactions working.`,
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when balance < threshold
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
