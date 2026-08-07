/**
 * AgentGuard pause-protected vault starter template.
 *
 * A public hub workflow that pauses a SecurityVault on-chain. This is the
 * "zero to first protection transaction" starter for the KeeperHub Agents
 * Onchain hackathon track: deploy a minimal SecurityVault (or paste your
 * own contract address), then trigger this workflow to pause it via the
 * `web3/write-contract` action — executed by the KeeperHub execution layer,
 * so the agent never holds the private key.
 *
 * Companion tutorial: docs/getting-started/agentguard-pause-template.md
 *
 * The ABI is embedded so the workflow runs even before the contract is
 * verified on a block explorer (unverified contracts cannot be auto-fetched).
 *
 * Placeholder values for user-specific fields (contract address) are the
 * default SecurityVault shipped with the template; replace `contractAddress`
 * with your own deployment after following the tutorial.
 */

import { computeAutoLayout } from "@/lib/workflow/editor/auto-layout";
import {
  buildActionNode,
  buildEdge,
  buildTriggerNode,
  type WorkflowNodeJson,
} from "@/lib/workflow/node-builders";

export type AgentGuardPauseFixture = {
  id: string;
  listedSlug: string;
  name: string;
  description: string;
  featuredProtocol: string;
  nodes: unknown[];
  edges: unknown[];
};

function withAutoLayout(
  fixture: AgentGuardPauseFixture
): AgentGuardPauseFixture {
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

// Minimal SecurityVault ABI (pause / unpause / emergencyWithdraw + Ownable).
// Keep in sync with the starter contract in the tutorial.
const SECURITY_VAULT_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_guardian", type: "address" },
      { internalType: "address", name: "_recovery", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "oldGuardian",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newGuardian",
        type: "address",
      },
    ],
    name: "GuardianChanged",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "runId",
        type: "bytes32",
      },
    ],
    name: "EmergencyWithdraw",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "oldRecovery",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newRecovery",
        type: "address",
      },
    ],
    name: "RecoveryChanged",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "by",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "ts",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "string",
        name: "reason",
        type: "string",
      },
    ],
    name: "VaultPaused",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "by",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "ts",
        type: "uint256",
      },
    ],
    name: "VaultUnpaused",
    type: "event",
  },
  {
    inputs: [],
    name: "emergencyWithdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "guardian",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "string", name: "reason", type: "string" }],
    name: "pause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "recovery",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_guardian", type: "address" }],
    name: "setGuardian",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_recovery", type: "address" }],
    name: "setRecovery",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "unpause",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { stateMutability: "payable", type: "receive" },
] as const;

const RAW_FIXTURES: AgentGuardPauseFixture[] = [
  {
    id: "agentguard-pause-vault",
    listedSlug: "agentguard-pause",
    name: "AgentGuard: Pause SecurityVault",
    description:
      "Manually pause a SecurityVault on-chain via a web3/write-contract action. The KeeperHub execution layer broadcasts the pause, so the agent never holds the private key.",
    featuredProtocol: "security-vault",
    nodes: [
      buildTriggerNode("trigger-1", {
        triggerType: "Manual",
      }),
      buildActionNode(
        "step-1",
        "Pause SecurityVault",
        "Call pause(string) on the SecurityVault contract — broadcast by the KeeperHub execution layer (guardian account)",
        {
          actionType: "web3/write-contract",
          network: 11155111, // Sepolia — change to 8453 for Base mainnet
          contractAddress:
            "0xBda3ca77aC1442f13A57b136430C383DBf7DC891", // replace with your deployed vault
          abiFunction: "pause",
          functionArgs: ['["risk score 70 >= 70"]'],
          abi: JSON.stringify(SECURITY_VAULT_ABI),
        },
        400
      ),
    ],
    edges: [buildEdge("trigger-1", "step-1")],
  },
];

export const AGENTGUARD_PAUSE_FIXTURES: AgentGuardPauseFixture[] =
  RAW_FIXTURES.map(withAutoLayout);
