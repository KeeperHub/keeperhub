import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  agentDescription,
  agentName,
  DEFAULT_AGENT_NAME,
  deriveBaseUrl,
} from "@/lib/agent-identity";
import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
} from "@/lib/agentic-wallet/constants";
import { db } from "@/lib/db";
import { agentRegistrations } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getAuthenticatedToolsForDiscovery } from "@/lib/mcp/mcp-tool-catalog";

// Shares its chain id and registry address with scripts/register-agent.ts via
// lib/agentic-wallet/constants.ts, so the row this endpoint looks up cannot
// drift from the row the registration script writes. The endpoint serves the
// public ERC-8004 discovery payload and must return the canonical mainnet
// registration regardless of how many other (chain, registry) rows exist in
// the table.
const MAINNET_CHAIN_ID = ETHEREUM_MAINNET_CHAIN_ID;
const IDENTITY_REGISTRY_ADDRESS = ERC_8004_IDENTITY_REGISTRY_ADDRESS;

export async function GET(request: Request): Promise<NextResponse> {
  const baseUrl = deriveBaseUrl(request);
  // The ENS name and agent wallet are KeeperHub's own and have no configurable
  // equivalent, so they are published only by a deployment that has not renamed
  // itself. Same reasoning as the on-chain block elsewhere: a card carrying our
  // wallet under someone else's name is worse than one without it.
  const isKeeperHub = agentName() === DEFAULT_AGENT_NAME;
  try {
    const rows = await db
      .select()
      .from(agentRegistrations)
      .where(
        and(
          eq(agentRegistrations.chainId, MAINNET_CHAIN_ID),
          eq(agentRegistrations.registryAddress, IDENTITY_REGISTRY_ADDRESS)
        )
      )
      .limit(1);
    const registration = rows[0] ?? null;

    const registrationJson = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: agentName(),
      description: agentDescription(
        "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP."
      ),
      image: `${baseUrl}/keeperhub_logo.png`,
      services: [
        {
          name: "MCP",
          endpoint: `${baseUrl}/.well-known/mcp.json`,
          version: "2025-06-18",
          mcpTools: getAuthenticatedToolsForDiscovery(),
        },
        {
          name: "A2A",
          endpoint: `${baseUrl}/.well-known/agent-card.json`,
          version: "0.3.0",
        },
        {
          name: "workflows",
          endpoint: `${baseUrl}/api/mcp/workflows`,
        },
        { name: "web", endpoint: baseUrl },
        ...(isKeeperHub
          ? [
              { name: "ens", endpoint: "keeperhub.eth" },
              {
                name: "agentWallet",
                endpoint: "eip155:1:0xaa70faa583c0889164cfd9b45aa075f6c4388fee",
              },
            ]
          : []),
      ],
      supportedTrust: ["reputation"],
      x402Support: true,
      active: true,
      updatedAt: registration
        ? Math.floor(registration.registeredAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      registrations: registration
        ? [
            {
              agentId: registration.agentId,
              agentRegistry: `eip155:1:${registration.registryAddress}`,
            },
          ]
        : [],
    };

    return NextResponse.json(registrationJson, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[agent-registry] Failed to load registration",
      err,
      { endpoint: "/api/agent-registry" }
    );
    return NextResponse.json(
      { error: "Failed to load agent registry" },
      { status: 500 }
    );
  }
}
