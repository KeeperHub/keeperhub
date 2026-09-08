// Static MCP server card. Lets ERC-8004 indexers (e.g. 8004scan, thespawn)
// discover the tool catalog. The advertised `endpoint` is the ANONYMOUS
// /mcp/public marketplace surface, so a marketplace liveness probe can complete
// an unauthenticated initialize + tools/list (and call listed workflows). The
// authenticated, org-scoped surface is advertised separately under
// `authenticatedEndpoint` (OAuth-gated /mcp).

import {
  agentDescription,
  agentName,
  deriveBaseUrl,
  onChainIdentity,
} from "@/lib/agent-identity";
import { getAuthenticatedToolsForDiscovery } from "@/lib/mcp/mcp-tool-catalog";
import { PUBLIC_TOOLS } from "@/lib/mcp/oauth-scopes";

// Server names are slugs, so a configured display name has to be reduced to
// one. Matches the shape of the previous hardcoded "keeperhub".
const NON_SLUG_CHARS = /[^a-z0-9]+/g;

const TOOLS = getAuthenticatedToolsForDiscovery();

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const onChain = onChainIdentity();
  const card = {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    schema_version: "2025-06-18",
    version: "1.0.0",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: agentName().toLowerCase().replace(NON_SLUG_CHARS, "-"),
      title: agentName(),
      version: "1.0.0",
    },
    description: agentDescription(
      "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP and x402 micropayments."
    ),
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
    // Omitted entirely when there is no registration this deployment can
    // truthfully claim - see onChainIdentity(). Republishing ours under another
    // name would send reputation readers to the wrong host.
    ...(onChain
      ? {
          erc8004: {
            agent_id: onChain.agentId,
            chain: onChain.chain,
            chain_id: onChain.chainId,
            registry: onChain.registry,
          },
        }
      : {}),
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
