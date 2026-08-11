import { NextResponse } from "next/server";
import { type OAuthScope, scopeSatisfies } from "@/lib/mcp/oauth-scopes";

/**
 * A-03: enforce OAuth token scope at the REST sinks that MCP tools forward to.
 * OAuth tokens carry a scope (mcp:read|write|admin) the MCP tool wrapper
 * checks, but the REST routes those tools call dropped it and ran any
 * authenticated token. `grantedScope === undefined` means a non-OAuth caller
 * (kh_ key / cookie session / internal service) which is intentionally
 * full-access. Returns a 403 envelope (RFC 6750 3.1) when denied, null when
 * allowed.
 */
export function requireScope(
  grantedScope: string | undefined,
  required: OAuthScope
): NextResponse | null {
  if (scopeSatisfies(grantedScope, required)) {
    return null;
  }
  return NextResponse.json(
    {
      error: "insufficient_scope",
      message: `This endpoint requires the \`${required}\` OAuth scope. The current token has \`${grantedScope || "(none)"}\`.`,
      required_scope: required,
      granted_scope: grantedScope ?? "",
    },
    { status: 403 }
  );
}
