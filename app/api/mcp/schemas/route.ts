import { NextResponse } from "next/server";
import { buildActionSchemasResponse } from "@/lib/action-schemas/builder";

/**
 * GET /api/mcp/schemas
 *
 * Returns all workflow schemas for the MCP server.
 * This is the source of truth that the KeeperHub MCP fetches from.
 *
 * Query params:
 * - category: Filter to a specific plugin/category (e.g. "web3", "system", "discord")
 * - includeChains: "false" to skip the chains DB lookup (default: include)
 *
 * Shape, response keys, and cache headers are stable; the shared builder
 * in lib/action-schemas/builder.ts is also used by the public REST
 * surface at /api/action-schemas so the two cannot drift.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") ?? undefined;
  const includeChains = searchParams.get("includeChains") !== "false";

  const response = await buildActionSchemasResponse({
    category,
    includeChains,
    endpointLabel: "/api/mcp/schemas",
  });

  return NextResponse.json(response, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
