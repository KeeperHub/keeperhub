// Static MCP server card. Lets ERC-8004 indexers (e.g. 8004scan, thespawn)
// discover the tool catalog. The advertised `endpoint` is the ANONYMOUS
// /mcp/public marketplace surface, so a marketplace liveness probe can complete
// an unauthenticated initialize + tools/list (and call listed workflows). The
// authenticated, org-scoped surface is advertised separately under
// `authenticatedEndpoint` (OAuth-gated /mcp).

import { getAuthenticatedToolsForDiscovery } from "@/lib/mcp/mcp-tool-catalog";
import { PUBLIC_TOOLS } from "@/lib/mcp/oauth-scopes";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const TOOLS = getAuthenticatedToolsForDiscovery();

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    schema_version: "2025-06-18",
    version: "1.0.0",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "keeperhub",
      title: "KeeperHub",
      version: "1.0.0",
    },
    description:
      "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP and x402 micropayments.",
    iconUrl: `${baseUrl}/keeperhub_logo.png`,
    endpoint: `${baseUrl}/mcp/public`,
    transport: {
      type: "streamable-http",
      endpoint: "/mcp/public",
    },
    capabilities: { tools: {} },
    tools: [...PUBLIC_TOOLS],
    authentication: {
      required: false,
    },
    // Full org-scoped surface (manage your own workflows, integrations, wallet,
    // executions). OAuth-gated; org clients connect here, not to the public
    // endpoint above.
    authenticatedEndpoint: {
      endpoint: `${baseUrl}/mcp`,
      transport: {
        type: "streamable-http",
        endpoint: "/mcp",
      },
      tools: TOOLS,
      authentication: {
        required: true,
        type: "oauth2",
        resource_metadata: `${baseUrl}/.well-known/oauth-protected-resource`,
      },
    },
    erc8004: {
      agent_id: 31_875,
      chain: "ethereum",
      chain_id: 1,
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    },
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
