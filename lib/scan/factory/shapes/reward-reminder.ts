/**
 * Staking reward-claim reminder workflow shape.
 *
 * Topology: Schedule trigger -> check-token-balance -> Condition (balance > 0) -> Email reminder
 *
 * Polls every 6 hours and reminds the user to claim staking rewards when a
 * non-zero staked token balance is detected. Defaults to monitoring a
 * user-specified staking token (e.g. Lido wstETH); Phase 53 confirm screen
 * populates walletAddress and stakingTokenAddress before saving.
 *
 * Read-only — uses only read action types so validateWorkflow with
 * workflowType "read" produces zero errors and zero warnings (PREFILL-06).
 *
 * Requirements: PREFILL-01, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06
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

/** Poll every 6 hours — well above the 60s floor (PREFILL-05). */
const REWARD_REMINDER_CRON = "0 */6 * * *";

// ---------------------------------------------------------------------------
// Shape builder
// ---------------------------------------------------------------------------

export interface RewardReminderOutput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Build the staking reward-claim reminder workflow shape.
 *
 * Reads the staked token balance on-chain and fires an email reminder when the
 * balance is above zero, prompting the user to consider claiming accumulated
 * staking rewards (e.g. Lido wstETH/stETH rewards).
 *
 * Node IDs are derived from the descriptor slug for determinism (PREFILL-03).
 * config.network is set to String(chainId) on all web3 nodes (PREFILL-04).
 *
 * The descriptor is expected to carry:
 *   - chainId: number (e.g. 1 for Ethereum mainnet)
 *   - confirmInputs.walletAddress: placeholder shown on Phase 53 confirm screen
 *   - confirmInputs.stakingTokenAddress: staking token address placeholder
 */
export function buildRewardReminder(
  descriptor: SuggestionDescriptor
): RewardReminderOutput {
  const slug = descriptor.id;
  const network = String(descriptor.chainId);

  // Node IDs: ${slug}-${role} (PREFILL-03)
  const triggerId = `${slug}-trigger`;
  const readId = `${slug}-read`;
  const conditionId = `${slug}-condition`;
  const alertId = `${slug}-alert`;

  // Template ref for the raw balance output field from check-token-balance
  const balanceRef = `{{@${readId}:Check Staking Balance.balance.balanceRaw}}`;

  // tokenConfig: JSON string describing the staking token selection.
  // Uses "custom" mode so Phase 53 can render a token picker.
  const tokenConfig = JSON.stringify({
    mode: "custom",
    customToken: {
      // Real staking token address when the engine prefilled it (Sky carries
      // the actual sUSDS address); placeholder otherwise
      address: resolveAddressPrefill(
        descriptor.confirmInputs.stakingTokenAddress,
        "{{stakingTokenAddress}}"
      ),
      symbol: "STAKING",
    },
  });

  const nodes: WorkflowNode[] = [
    buildScheduleTrigger(triggerId, { cron: REWARD_REMINDER_CRON }, 0),
    buildCheckTokenBalanceNode(
      readId,
      {
        label: "Check Staking Balance",
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
        label: "Staking Balance Above Zero",
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
        label: "Send Reward Reminder",
        subject: "KeeperHub reminder: staking balance update",
        bodyTemplate: `Staking rewards available to claim. Balance: ${balanceRef}`,
      },
      3
    ),
  ];

  const edges: WorkflowEdge[] = [
    buildEdge(triggerId, readId),
    buildEdge(readId, conditionId),
    // Condition true-branch: reminder fires when staking balance > 0
    buildEdge(conditionId, alertId, "true"),
  ];

  return { nodes, edges };
}
