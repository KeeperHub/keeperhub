import { describe, expect, it } from "vitest";
import { AUTHENTICATED_MCP_TOOLS } from "@/lib/mcp/mcp-tool-catalog";
import {
  isToolAllowed,
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/mcp/oauth-scopes";

/**
 * Every tool judged against every scope.
 *
 * The write and execute tools cannot be exercised over HTTP to prove they are
 * refused: reaching the scope gate means sending valid arguments, and if the
 * gate were broken the call would go through, moving funds or deleting a
 * workflow to find out. This asserts the decision the gate makes instead, over
 * the whole catalog, so a tool added to the wrong set fails here rather than in
 * production.
 */

/** Tools a read-only agent may call. Everything else must be refused. */
const READ_SAFE = new Set<string>([
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

/**
 * Tools that move funds or sign transactions.
 *
 * These are in WRITE_TOOLS, so mcp:write reaches them: today "read and write"
 * and "full access" permit exactly the same 44 tools. That is asserted rather
 * than wished for, so this test tells the truth about the model; if the two
 * levels are ever separated, the assertion below is what will catch it.
 */
const MOVES_FUNDS = new Set<string>([
  "execute_transfer",
  "execute_contract_call",
  "execute_protocol_action",
  "execute_check_and_execute",
  "tempo_sign_and_hold",
  "tempo_cancel_hold",
  "tempo_release_hold",
]);

describe("MCP tool scope matrix", () => {
  it("has a catalog to check", () => {
    expect(AUTHENTICATED_MCP_TOOLS.length).toBeGreaterThan(40);
  });

  it("lets a read-only agent call exactly the read tools", () => {
    const allowed = AUTHENTICATED_MCP_TOOLS.filter((tool) =>
      isToolAllowed(tool, SCOPE_MCP_READ)
    );
    expect([...allowed].sort()).toEqual([...READ_SAFE].sort());
  });

  it("refuses every fund-moving tool to a read-only agent", () => {
    for (const tool of MOVES_FUNDS) {
      expect(isToolAllowed(tool, SCOPE_MCP_READ), tool).toBe(false);
    }
  });

  it("records that write currently reaches the fund-moving tools too", () => {
    // Not an endorsement: this pins the current model so that separating
    // write from full access is a deliberate change with a failing test to
    // update, rather than a silent one.
    for (const tool of MOVES_FUNDS) {
      expect(isToolAllowed(tool, SCOPE_MCP_WRITE), tool).toBe(true);
    }
  });

  it("records that write and full access permit the same catalog today", () => {
    const atWrite = AUTHENTICATED_MCP_TOOLS.filter((t) =>
      isToolAllowed(t, SCOPE_MCP_WRITE)
    );
    const atAdmin = AUTHENTICATED_MCP_TOOLS.filter((t) =>
      isToolAllowed(t, SCOPE_MCP_ADMIN)
    );
    expect(atWrite).toEqual(atAdmin);
  });

  it("keeps every read tool available to a write agent", () => {
    for (const tool of READ_SAFE) {
      expect(isToolAllowed(tool, SCOPE_MCP_WRITE), tool).toBe(true);
    }
  });

  it("allows the whole catalog to a full-access agent", () => {
    for (const tool of AUTHENTICATED_MCP_TOOLS) {
      expect(isToolAllowed(tool, SCOPE_MCP_ADMIN), tool).toBe(true);
    }
  });

  it("refuses everything to an empty scope", () => {
    for (const tool of AUTHENTICATED_MCP_TOOLS) {
      expect(isToolAllowed(tool, ""), tool).toBe(false);
    }
  });
});
