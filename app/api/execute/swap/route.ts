import "server-only";

import { NextResponse } from "next/server";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { validateApiKey } from "../_lib/auth";
import { rejectSimulateQuery } from "../_lib/simulate-flag";

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if ("error" in apiKeyCtx) {
    return NextResponse.json(
      { error: apiKeyCtx.error },
      { status: apiKeyCtx.status }
    );
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE, {
    organizationId: apiKeyCtx.organizationId,
    credentialId: apiKeyCtx.apiKeyId,
    credentialType: apiKeyCtx.credentialType,
    endpoint: "/api/execute/swap",
  });
  if (scopeError) {
    return scopeError;
  }

  // #2004: ?simulate= is refused rather than ignored on every /api/execute/*
  // route, including this stub. The body is never read here, so there is no
  // body flag to refuse -- the 501 already refuses everything.
  const simulateQuery = rejectSimulateQuery(request);
  if (simulateQuery) {
    return simulateQuery;
  }

  return NextResponse.json({ message: "Coming soon" }, { status: 501 });
}
