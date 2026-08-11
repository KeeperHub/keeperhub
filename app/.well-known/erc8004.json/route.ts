// Canonical ERC-8004 metadata for the KeeperHub agent. Lets third-party
// indexers (e.g. 8004scan) and reputation readers discover KH's registered
// agent identity, registry contract, and where to fetch richer cards from
// — without round-tripping through MCP or the on-chain registry directly.
//
// KEEP-475: this endpoint used to return 404, forcing callers to query the
// canonical Base Sepolia ReputationRegistry on chain to find KH. The agent
// already exists (mcp.json route lines 76-81); only the well-known wrapper
// was missing.

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    schema_version: "1",
    name: "KeeperHub",
    description:
      "Execution layer for AI agents operating onchain. ERC-8004 agent identity for KeeperHub workflows.",
    agent_id: 31_875,
    chain: "ethereum",
    chain_id: 1,
    registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
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
      // read directly from the on-chain registry.
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      chain_id: 1,
    },
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
