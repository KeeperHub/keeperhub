export const SCOPE_MCP_READ = "mcp:read";
export const SCOPE_MCP_WRITE = "mcp:write";
export const SCOPE_MCP_ADMIN = "mcp:admin";

export const SUPPORTED_SCOPES = [
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
  SCOPE_MCP_ADMIN,
] as const;

export type OAuthScope = (typeof SUPPORTED_SCOPES)[number];

// Server-internal scope for the anonymous /mcp/public endpoint. It is NOT in
// SUPPORTED_SCOPES on purpose: callers can never request it through the OAuth
// authorize flow, so it can only ever be assigned by the server to an
// unauthenticated marketplace caller. It grants EXACTLY the tools in
// PUBLIC_TOOLS and nothing else.
export const SCOPE_MCP_PUBLIC = "mcp:public";

// The only tools an anonymous caller may list or invoke. Each one proxies an
// endpoint that is already public over HTTP (no org/user scoping), so exposing
// it over MCP reveals no new data. This is a hand-curated allowlist, NOT a
// derivation from READ_TOOLS -- several read tools (validate_workflow,
// prepare_test_pin_data, list_workflows, get_wallet_integration, ...) are
// org-scoped and must never be anonymously reachable.
export const PUBLIC_TOOLS = new Set<string>([
  "search_workflows",
  "get_workflow_listing",
  "search_templates",
  "list_action_schemas",
  "search_plugins",
  "search_protocol_actions",
  "get_plugin",
  "tools_documentation",
  "call_workflow",
]);

const READ_TOOLS = new Set<string>([
  "list_workflows",
  "get_workflow",
  "get_execution",
  "get_execution_status",
  "get_execution_logs",
  "list_executions",
  "validate_cron",
  "get_spending_limits",
  "list_action_schemas",
  "search_plugins",
  "get_plugin",
  "list_integrations",
  "get_wallet_integration",
  "search_templates",
  "get_template",
  "tools_documentation",
  "search_protocol_actions",
  "get_direct_execution_status",
  "search_workflows",
  "validate_workflow",
  "prepare_test_pin_data",
  "get_workflow_listing",
  "list_projects",
  "list_tags",
]);

const WRITE_TOOLS = new Set<string>([
  ...READ_TOOLS,
  "create_workflow",
  "update_workflow",
  "create_project",
  "create_tag",
  "delete_workflow",
  "execute_workflow",
  "deploy_template",
  "ai_generate_workflow",
  "execute_protocol_action",
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
  "call_workflow",
  "list_workflow",
  "unlist_workflow",
  "update_workflow_listing",
  "test_notification",
  "tempo_sign_and_hold",
  "tempo_cancel_hold",
  "tempo_release_hold",
]);

export function isScopeValid(scope: string): boolean {
  return SUPPORTED_SCOPES.includes(scope as OAuthScope);
}

export function parseScopes(scopeString: string): string[] {
  return scopeString
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isToolAllowed(toolName: string, scopeString: string): boolean {
  const scopes = parseScopes(scopeString);

  // Public scope is terminal and deny-by-default: it grants ONLY the public
  // allowlist and never falls through to read/write/admin. Checked first so a
  // (server-only) public token can never be widened, even if some future code
  // path concatenated another scope onto it.
  if (scopes.includes(SCOPE_MCP_PUBLIC)) {
    return PUBLIC_TOOLS.has(toolName);
  }

  if (scopes.includes(SCOPE_MCP_ADMIN)) {
    return true;
  }

  if (scopes.includes(SCOPE_MCP_WRITE) && WRITE_TOOLS.has(toolName)) {
    return true;
  }

  if (scopes.includes(SCOPE_MCP_READ) && READ_TOOLS.has(toolName)) {
    return true;
  }

  return false;
}

export function normalizeScope(requestedScope: string): string {
  const requested = parseScopes(requestedScope);
  const valid = requested.filter((s) => isScopeValid(s));
  return valid.length > 0 ? valid.join(" ") : SCOPE_MCP_READ;
}

/**
 * Coerce the `scopes` field from an API request body (array or space-separated
 * string) into a normalized scope string, or null when omitted.
 */
export function parseScopeInput(scopes: unknown): string | null {
  if (Array.isArray(scopes)) {
    const raw = scopes
      .filter((s): s is string => typeof s === "string")
      .join(" ");
    return raw.trim() ? normalizeScope(raw) : null;
  }
  if (typeof scopes === "string") {
    return scopes.trim() ? normalizeScope(scopes) : null;
  }
  return null;
}

/**
 * Return the minimum OAuth scope a caller needs to invoke the given tool.
 *
 * KEEP-483: when a tool denies for missing scope, the client must be told
 * which scope to request on reauthorize. Previously the MCP wrapper
 * returned a generic "Forbidden" so builders had no actionable signal —
 * the Hydra report observed write tools all denied with no clue that
 * `mcp:write` was the missing piece.
 */
export function getRequiredScopeForTool(toolName: string): OAuthScope {
  // READ_TOOLS is a strict subset of WRITE_TOOLS, so a tool present in
  // READ_TOOLS satisfies the read scope. Tools in WRITE_TOOLS only need
  // write. Anything else (unknown / admin-only) falls back to admin.
  if (READ_TOOLS.has(toolName)) {
    return SCOPE_MCP_READ;
  }
  if (WRITE_TOOLS.has(toolName)) {
    return SCOPE_MCP_WRITE;
  }
  return SCOPE_MCP_ADMIN;
}

const SCOPE_RANK: Record<OAuthScope, number> = {
  [SCOPE_MCP_READ]: 1,
  [SCOPE_MCP_WRITE]: 2,
  [SCOPE_MCP_ADMIN]: 3,
};

/**
 * True when `grantedScope` satisfies the `required` scope level.
 * `undefined` means no scope restriction (kh_ API key / cookie session /
 * internal service) and always passes -- those callers are intentionally
 * full-access. An empty or all-invalid scope string fails for every level
 * (matches isToolAllowed("") === false). Only OAuth Bearer tokens are gated.
 */
export function scopeSatisfies(
  grantedScope: string | undefined,
  required: OAuthScope
): boolean {
  if (grantedScope === undefined) {
    return true;
  }
  const requiredRank = SCOPE_RANK[required];
  return parseScopes(grantedScope).some(
    (s) => isScopeValid(s) && SCOPE_RANK[s as OAuthScope] >= requiredRank
  );
}
