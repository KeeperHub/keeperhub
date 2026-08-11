import { NextResponse } from "next/server";
import { buildActionSchemasResponse } from "@/lib/action-schemas/builder";
import { authenticateApiKey } from "@/lib/api-key-auth";

/**
 * GET /api/action-schemas
 *
 * Public, bearer-authenticated REST entry point for plugin action
 * schemas. Returns the same payload shape as the MCP `list_action_schemas`
 * tool (which internally hits /api/mcp/schemas). Lets REST integrators
 * introspect available actions without going through MCP.
 *
 * Auth: Authorization: Bearer kh_xxxxx (organization API key).
 *
 * Query params:
 *   - type: actionType to filter the `actions` map to a single entry
 *     (e.g. "web3.read-contract"). Other top-level keys (triggers,
 *     chains, platform, ...) are returned unchanged.
 *   - category: plugin/category filter (e.g. "web3", "discord", "system").
 *   - includeChains: "false" to skip the chains DB lookup.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateApiKey(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.statusCode ?? 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? undefined;
  const category = searchParams.get("category") ?? undefined;
  const includeChains = searchParams.get("includeChains") !== "false";

  const response = await buildActionSchemasResponse({
    category,
    includeChains,
    type,
    endpointLabel: "/api/action-schemas",
  });

  return NextResponse.json(response, {
    headers: {
      "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
    },
  });
}
