/**
 * Single source of truth for authenticated MCP tool names used in discovery
 * manifests (ERC-8004, /.well-known/mcp.json, agent-registry).
 *
 * Keep in sync with registerTools + registerMetaTools in lib/mcp/tools.ts.
 */

/** Deprecated tool names mapped to their replacement. */
export const DEPRECATED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  get_execution_logs: "get_execution",
  get_execution_status: "get_execution",
  get_template: "get_workflow",
  search_plugins: "list_action_schemas",
};

/**
 * All tools on the authenticated /mcp surface, including deprecated aliases.
 * Sorted alphabetically for stable manifest diffs.
 */
export const AUTHENTICATED_MCP_TOOLS: readonly string[] = [
  "ai_generate_workflow",
  "call_workflow",
  "create_project",
  "create_tag",
  "create_workflow",
  "delete_workflow",
  "deploy_template",
  "execute_check_and_execute",
  "execute_contract_call",
  "execute_protocol_action",
  "execute_transfer",
  "execute_workflow",
  "get_direct_execution_status",
  "get_execution",
  "get_execution_logs",
  "get_execution_status",
  "get_plugin",
  "get_spending_limits",
  "get_template",
  "get_wallet_integration",
  "get_workflow",
  "get_workflow_listing",
  "list_action_schemas",
  "list_executions",
  "list_integrations",
  "list_projects",
  "list_tags",
  "list_workflow",
  "list_workflows",
  "prepare_test_pin_data",
  "search_plugins",
  "search_protocol_actions",
  "search_templates",
  "search_workflows",
  "tempo_cancel_hold",
  "tempo_release_hold",
  "tempo_sign_and_hold",
  "test_notification",
  "tools_documentation",
  "unlist_workflow",
  "update_workflow",
  "update_workflow_listing",
  "validate_cron",
  "validate_workflow",
] as const;

/** Tool names for discovery manifests (deduped, stable order). */
export function getAuthenticatedToolsForDiscovery(): string[] {
  return [...AUTHENTICATED_MCP_TOOLS];
}

export const DEPRECATED_PREFIX_EXECUTION =
  "[DEPRECATED — will be removed in v1.13. Use get_execution instead.]";

const DEPRECATED_PREFIX =
  "[DEPRECATED — will be removed in v1.13. Use {{replacement}} instead.]";

/** Build the v1.13 deprecation prefix for a registered alias tool. */
export function deprecatedToolDescription(
  toolName: string,
  body: string
): string {
  const replacement = DEPRECATED_TOOL_ALIASES[toolName];
  if (!replacement) {
    return body;
  }
  const prefix = DEPRECATED_PREFIX.replace("{{replacement}}", replacement);
  return `${prefix} ${body}`;
}
