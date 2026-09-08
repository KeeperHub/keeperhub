// A2A Agent Card (https://a2a-protocol.org). Referenced from the ERC-8004
// agent registry as the "A2A" service so 8004scan can discover capabilities
// without an MCP handshake.

import {
  agentDescription,
  agentName,
  deriveBaseUrl,
} from "@/lib/agent-identity";

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    name: agentName(),
    description: agentDescription(
      "Execution layer for AI agents operating onchain. Discover and call DeFi workflows via MCP and ERC-8004, pay per execution in USDC over x402 on Base or MPP on Tempo. Managed DeFi 24/7 with onchain audit trail."
    ),
    url: baseUrl,
    version: "1.0.0",
    provider: {
      organization: agentName(),
      url: baseUrl,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text", "application/json"],
    defaultOutputModes: ["application/json"],
    authentication: { schemes: ["bearer"] },
    skills: [
      {
        id: "workflow_discovery",
        name: "Workflow Discovery",
        description:
          "Search and list KeeperHub-listed DeFi workflows by keyword, protocol, asset, chain, or pricing. Returns name, price, input schema, and supported payment rails (x402, MPP).",
        tags: ["discovery", "search", "workflow", "marketplace", "defi"],
      },
      {
        id: "workflow_invocation",
        name: "Workflow Invocation",
        description:
          "Pay per execution and invoke a listed DeFi workflow with structured inputs. Paid workflows settle via x402 USDC on Base or MPP USDC.e on Tempo. Returns transaction hashes and a structured payment receipt.",
        tags: ["execution", "x402", "mpp", "usdc", "base", "tempo", "payments"],
      },
      {
        id: "ai_workflow_generation",
        name: "AI Workflow Generation",
        description:
          "Generate a new automation workflow from a natural-language goal, including triggers, conditional logic, and multi-step protocol actions across chains.",
        tags: [
          "ai",
          "generation",
          "natural-language",
          "workflow",
          "automation",
        ],
      },
      {
        id: "protocol_actions",
        name: "Protocol Actions",
        description:
          "Search and execute Web3 protocol actions (DeFi, governance, NFT, bridging, lending) across supported chains. Aave, Safe, swap routers, lending markets and more.",
        tags: [
          "defi",
          "web3",
          "protocol",
          "onchain",
          "aave",
          "safe",
          "lending",
          "governance",
        ],
      },
      {
        id: "onchain_execution",
        name: "Onchain Execution",
        description:
          "Execute token transfers, swaps, bridges, stakes, contract calls, and conditional check-and-execute transactions across Base, Ethereum, Tempo and other supported chains.",
        tags: [
          "transfer",
          "swap",
          "bridge",
          "stake",
          "contract",
          "execution",
          "onchain",
        ],
      },
      {
        id: "templates",
        name: "Workflow Templates",
        description:
          "Browse curated workflow templates (multisig automation, treasury management, DeFi position management) and deploy them with one call.",
        tags: ["template", "deploy", "marketplace", "treasury", "multisig"],
      },
      {
        id: "execution_monitoring",
        name: "Execution Monitoring",
        description:
          "Stream or poll workflow execution status, transaction hashes, gas spent, and per-step logs for debugging and audit. Full onchain audit trail per execution.",
        tags: ["monitoring", "status", "logs", "audit", "observability"],
      },
      {
        id: "reputation_feedback",
        name: "Reputation Feedback",
        description:
          "Record ERC-8004 ReputationRegistry feedback for a workflow execution. Wallet-signed and broadcast onchain. Feeds external scorers (Valiron, AgentScore, AgentSign).",
        tags: ["reputation", "feedback", "erc-8004", "audit", "trust"],
      },
    ],
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
