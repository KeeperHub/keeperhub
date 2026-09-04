import "server-only";

import { NextResponse } from "next/server";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { validateApiKey } from "../_lib/auth";

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

  return NextResponse.json({ message: "Coming soon" }, { status: 501 });
}
