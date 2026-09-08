/**
 * Generic token/balance-monitor fallback workflow shape.
 *
 * Topology: Schedule trigger -> check-token-balance -> Condition (balance > 0) -> Email alert
 *
 * Used as the dispatcher default for any suggestion category not covered by a
 * specific shape. Runs a minimal daily read-only balance check and alerts when
 * a non-zero balance is detected. Phase 53 confirm screen populates
 * walletAddress and tokenAddress before saving.
 *
 * Read-only — uses only read action types so validateWorkflow with
 * workflowType "read" produces zero errors and zero warnings (PREFILL-06).
 *
 * Requirements: PREFILL-01, PREFILL-02, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06
 */

import {
  buildCheckTokenBalanceNode,
  buildConditionNode,
  buildEdge,
  buildEmailAlertNode,
  buildScheduleTrigger,
  resolveAddressPrefill,
} from "@/lib/scan/factory/node-builders";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Schedule defaults
// ---------------------------------------------------------------------------

/** Run once daily at 9am UTC — well above the 60s floor (PREFILL-05). */
const GENERIC_MONITOR_CRON = "0 9 * * *";

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface GenericMonitorOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the generic token/balance-monitor fallback workflow shape.
 *
 * Checks an ERC20 token balance on-chain once daily and alerts when a
 * non-zero balance is detected. This shape is the dispatcher default,
 * providing a safe read-only fallback for any suggestion category without
 * a dedicated shape.
 *
 * Node IDs are derived from the descriptor slug for determinism (PREFILL-03).
 * config.network is set to String(chainId) on all web3 nodes (PREFILL-04).
 *
 * The descriptor is expected to carry:
 *   - chainId: number (any supported chain)
 *   - confirmInputs.walletAddress: placeholder shown on Phase 53 confirm screen
 *   - confirmInputs.tokenAddress: ERC20 contract address placeholder
 */
export function buildGenericMonitor(
  descriptor: SuggestionDescriptor
): GenericMonitorOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  // Template ref for the raw balance output field from check-token-balance
  const balanceRef = `{{@${readId}:Check Token Balance.balance.balanceRaw}}`;

  // tokenConfig: JSON string describing the token selection.
  // Uses "custom" mode so Phase 53 can render a token picker.
  const tokenConfig = JSON.stringify({
    mode: "custom",
    customToken: {
      // Real token address when the engine prefilled it; placeholder otherwise
      address: resolveAddressPrefill(
        descriptor.confirmInputs.tokenAddress,
        "{{tokenAddress}}"
      ),
      symbol: "TOKEN",
    },
  });

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: GENERIC_MONITOR_CRON }, 0),
    buildCheckTokenBalanceNode(
      readId,
      {
        label: "Check Token Balance",
        network,
        // Real scanned address when the engine prefilled it; placeholder otherwise
        address: resolveAddressPrefill(
          descriptor.confirmInputs.walletAddress,
          "{{walletAddress}}"
        ),
        tokenConfig,
      },
      1
    ),
    buildConditionNode(
      conditionId,
      {
        label: "Balance Changed",
        slug,
        leftOperand: balanceRef,
        operator: ">",
        rightOperand: "0",
      },
      2
    ),
    buildEmailAlertNode(
      alertId,
      {
        label: "Send Monitor Alert",
        subject: "KeeperHub alert: token balance update",
        bodyTemplate: `Token balance update: ${balanceRef}`,
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: alert fires when balance > 0
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
