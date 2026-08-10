/**
 * Onboarding workflow fixtures for the getting-started launcher.
 *
 * Eight public hub workflows: six mainnet chip starters plus Sepolia and
 * Base Sepolia variants of the Aave health monitor. Each is seeded with a
 * stable `id` and a `listedSlug` matching its chip id so the recommendations
 * endpoint can return the live workflow id by slug.
 *
 * Placeholder values for user-specific fields (wallet addresses, Discord
 * integration) are left as empty strings; the user fills them in after cloning.
 */

import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";
import {
  buildActionNode,
  buildConditionNode,
  buildDiscordNode,
  buildEdge,
  buildEmailNode,
  buildProtocolMeta,
  buildTriggerNode,
  type WorkflowNodeJson,
} from "@/lib/workflow/node-builders";

export type OnboardingWorkflowFixture = {
  id: string;
  listedSlug: string;
  name: string;
  description: string;
  featuredProtocol: string;
  nodes: unknown[];
  edges: unknown[];
};

// Lay each fixture out with the same algorithm the editor's "Auto-layout"
// button uses, so a freshly seeded workflow already reads left-to-right and
// clicking Auto-layout is a no-op instead of rearranging the nodes.
function withAutoLayout(
  fixture: OnboardingWorkflowFixture
): OnboardingWorkflowFixture {
  const positions = computeAutoLayout(
    fixture.nodes as unknown as Parameters<typeof computeAutoLayout>[0],
    fixture.edges as unknown as Parameters<typeof computeAutoLayout>[1]
  );
  const nodes = (fixture.nodes as WorkflowNodeJson[]).map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });
  return { ...fixture, nodes };
}

function buildAaveHealthMonitorFixture(
  id: string,
  listedSlug: string,
  name: string,
  network: string
): OnboardingWorkflowFixture {
  return {
    id,
    listedSlug,
    name,
    description:
      "Check your Aave v3 health factor hourly, and when it drops below the 1.5 safety threshold alert both Discord and email.",
    featuredProtocol: "aave-v3",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 * * * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Get Aave Health Factor",
        "Read the health factor from Aave v3 for the monitored wallet",
        {
          actionType: "aave-v3/get-user-account-data",
          network,
          _protocolMeta: buildProtocolMeta(
            "aave-v3",
            "pool",
            "getUserAccountData",
            "read"
          ),
          user: "",
        },
        400
      ),
      buildConditionNode(
        "step-2",
        {
          condition:
            "{{@step-1:Get Aave Health Factor.healthFactor}} < 1500000000000000000",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand:
                  "{{@step-1:Get Aave Health Factor.healthFactor}}",
                operator: "<",
                rightOperand: "1500000000000000000",
              },
            ],
          },
        },
        600
      ),
      buildDiscordNode(
        "step-3",
        "Aave v3 health factor dropped to {{step-1.healthFactor}}, below the 1.5 safety threshold. Consider adding collateral or repaying debt.",
        800
      ),
      buildEmailNode(
        "step-4",
        "Aave health factor alert",
        "Your Aave v3 health factor is {{step-1.healthFactor}}, below the 1.5 safety threshold. Consider adding collateral or repaying debt to avoid liquidation.",
        1000
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2"),
      buildEdge("step-2", "step-3", "true"),
      buildEdge("step-2", "step-4", "true"),
    ],
  };
}

const RAW_FIXTURES: OnboardingWorkflowFixture[] = [
  buildAaveHealthMonitorFixture(
    "onb-aave-health",
    "aave-health",
    "Aave Health Factor Monitor",
    "1"
  ),
  buildAaveHealthMonitorFixture(
    "onb-aave-health-sepolia",
    "aave-health-sepolia",
    "Aave Health Factor Monitor (Sepolia)",
    "11155111"
  ),
  buildAaveHealthMonitorFixture(
    "onb-aave-health-base-sepolia",
    "aave-health-base-sepolia",
    "Aave Health Factor Monitor (Base Sepolia)",
    "84532"
  ),

  {
    id: "onb-whale-withdrawal",
    listedSlug: "whale-withdrawal",
    name: "Large Withdrawal Alert",
    description:
      "Watch for USDT transfers on mainnet and send a Discord alert only when the amount is above 100,000 USDT.",
    featuredProtocol: "erc20",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Event",
        network: "1",
        contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        eventName: "Transfer",
      }),
      buildConditionNode(
        "step-1",
        {
          condition: "{{@trigger-1:Trigger.value}} > 100000000000",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand: "{{@trigger-1:Trigger.value}}",
                operator: ">",
                rightOperand: "100000000000",
              },
            ],
          },
        },
        400
      ),
      buildDiscordNode(
        "step-2",
        "Large USDT transfer detected. From {{trigger.from}} to {{trigger.to}}, value {{trigger.value}}.",
        600
      ),
    ],
    edges: [
      buildEdge("trigger-1", "step-1"),
      buildEdge("step-1", "step-2", "true"),
    ],
  },

  {
    id: "onb-governance",
    listedSlug: "governance",
    name: "Aave Governance Proposal Alert",
    description:
      "Watch for new Aave governance proposals on mainnet and send an email when one is created.",
    featuredProtocol: "aave-v3",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Event",
        network: "1",
        contractAddress: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7",
        eventName: "ProposalCreated",
      }),
      buildEmailNode(
        "step-1",
        "New Aave governance proposal",
        "A new Aave governance proposal was created. Proposal id {{trigger.proposalId}}, proposer {{trigger.creator}}.",
        400
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1")],
  },

  {
    id: "onb-sky-staking",
    listedSlug: "sky-staking",
    name: "SKY Staking Optimizer",
    description:
      "Weekly: approve and deposit USDS into the stUSDS vault to earn staking rewards.",
    featuredProtocol: "sky",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 0 * * 1",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Approve stUSDS to Spend USDS",
        "Approve the stUSDS vault contract to transfer USDS on your behalf",
        {
          actionType: "sky/approve-usds",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "usds", "approve", "write"),
          spender: "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Deposit USDS into stUSDS Vault",
        "Stake USDS into the stUSDS vault and receive stUSDS shares",
        {
          actionType: "sky/st-usds-vault-deposit",
          network: "1",
          _protocolMeta: buildProtocolMeta(
            "sky",
            "stUsds",
            "deposit",
            "write"
          ),
          assets: "1000000000000000000",
          receiver: "",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },

  {
    id: "onb-steth-wrap",
    listedSlug: "steth-wrap",
    name: "Wrap stETH to wstETH",
    description:
      "Approve and wrap stETH into wstETH to hold a rebasing-protected yield token.",
    featuredProtocol: "lido",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Manual",
      }),
      buildActionNode(
        "step-1",
        "Approve wstETH to Spend stETH",
        "Approve the wstETH contract to transfer stETH on your behalf",
        {
          actionType: "lido/approve-steth",
          network: "1",
          _protocolMeta: buildProtocolMeta("lido", "steth", "approve", "write"),
          spender: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Wrap stETH into wstETH",
        "Convert stETH to wstETH via the Lido wrapper",
        {
          actionType: "lido/wrap",
          network: "1",
          _protocolMeta: buildProtocolMeta("lido", "wsteth", "wrap", "write"),
          stETHAmount: "1000000000000000000",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },

  {
    id: "onb-usds-savings",
    listedSlug: "usds-savings",
    name: "USDS Savings Vault Deposit",
    description:
      "Monthly: approve and deposit USDS into the sUSDS savings vault.",
    featuredProtocol: "sky",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Schedule",
        scheduleCron: "0 0 1 * *",
        scheduleTimezone: "UTC",
      }),
      buildActionNode(
        "step-1",
        "Approve sUSDS to Spend USDS",
        "Approve the sUSDS vault contract to transfer USDS on your behalf",
        {
          actionType: "sky/approve-usds",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "usds", "approve", "write"),
          spender: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
          amount: "1000000000000000000",
        },
        400
      ),
      buildActionNode(
        "step-2",
        "Deposit USDS into sUSDS Vault",
        "Deposit USDS into the Sky savings vault and receive sUSDS shares",
        {
          actionType: "sky/vault-deposit",
          network: "1",
          _protocolMeta: buildProtocolMeta("sky", "sUsds", "deposit", "write"),
          assets: "1000000000000000000",
          receiver: "",
        },
        600
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1"), buildEdge("step-1", "step-2")],
  },
];

export const ONBOARDING_WORKFLOW_FIXTURES: OnboardingWorkflowFixture[] =
  RAW_FIXTURES.map(withAutoLayout);
