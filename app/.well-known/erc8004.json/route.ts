// Canonical ERC-8004 metadata for the KeeperHub agent. Lets third-party
// indexers (e.g. 8004scan) and reputation readers discover KH's registered
// agent identity, registry contract, and where to fetch richer cards from
// — without round-tripping through MCP or the on-chain registry directly.
//
// KEEP-475: this endpoint used to return 404, forcing callers to query the
// canonical Ethereum mainnet registries on chain to find KH. The agent
// already exists (see the erc8004 block in the mcp.json route); only the
// well-known wrapper was missing.
//
// Identity and reputation are SEPARATE ERC-8004 contracts. The identity block
// comes from lib/agent-identity.ts, so a deployment can publish its own
// registration. The reputation address is imported from
// lib/agentic-wallet/constants.ts — the same source of truth the feedback route
// and the Turnkey policy use — so the pointer we publish cannot drift from
// where feedback is actually written on chain.

import {
  agentDescription,
  agentName,
  deriveBaseUrl,
  onChainIdentity,
} from "@/lib/agent-identity";
import {
  ERC_8004_REPUTATION_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
} from "@/lib/agentic-wallet/constants";

export function GET(request: Request): Response {
  const onChain = onChainIdentity();

  // This document IS an on-chain registration - there is no version of it
  // without one. A deployment that renamed the agent but registered no agent of
  // its own has nothing true to publish here, and republishing ours under their
  // name would point reputation readers at the wrong host while looking
  // entirely plausible. 404 is the honest answer; the endpoint returned exactly
  // that before the registration existed.
  if (!onChain) {
    return new Response(null, { status: 404 });
  }

  const baseUrl = deriveBaseUrl(request);
  const card = {
    schema_version: "1",
    name: agentName(),
    description: agentDescription(
      "Execution layer for AI agents operating onchain. ERC-8004 agent identity for KeeperHub workflows."
    ),
    agent_id: onChain.agentId,
    chain: onChain.chain,
    chain_id: onChain.chainId,
    registry: onChain.registry,
    cards: {
      mcp: `${baseUrl}/.well-known/mcp.json`,
      a2a: `${baseUrl}/.well-known/agent-card.json`,
    },
    endpoints: {
      mcp: `${baseUrl}/mcp`,
      api: `${baseUrl}/api`,
    },
    reputation: {
      type: "erc-8004",
      // Feedback writes flow through the agentic-wallet path; consumers
      // read directly from the on-chain ReputationRegistry — a different
      // contract from the IdentityRegistry above. Not part of the deployment
      // identity seam: the reputation contract is a fixed public deployment,
      // not something an operator registers.
      registry: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
      chain_id: ETHEREUM_MAINNET_CHAIN_ID,
    },
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
