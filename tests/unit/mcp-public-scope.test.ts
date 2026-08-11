import { describe, expect, it, vi } from "vitest";
import {
  isToolAllowed,
  PUBLIC_TOOLS,
  SCOPE_MCP_PUBLIC,
} from "@/lib/mcp/oauth-scopes";

// server.ts pulls in the MCP SDK + the full tool registry; stub them so we can
// import the registration filter in isolation.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(),
  ResourceTemplate: vi.fn(),
}));
vi.mock("@/lib/mcp/tools", () => ({
  registerTools: vi.fn(),
  registerMetaTools: vi.fn(),
}));

import { publicToolRegistrar } from "@/lib/mcp/server";

// Every tool that reads org/user data, mutates state, or executes onchain.
// None of these may EVER be anonymously listable or callable.
const FORBIDDEN_TOOLS = [
  "list_workflows",
  "get_workflow",
  "list_integrations",
  "get_wallet_integration",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "execute_workflow",
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
  "execute_protocol_action",
  "deploy_template",
  "ai_generate_workflow",
  "list_workflow",
  "unlist_workflow",
  "update_workflow_listing",
  "validate_workflow",
  "prepare_test_pin_data",
  "get_execution",
  "get_direct_execution_status",
  "get_template",
];

describe("mcp:public scope — deny by default", () => {
  it("grants exactly the PUBLIC_TOOLS allowlist", () => {
    for (const tool of PUBLIC_TOOLS) {
      expect(isToolAllowed(tool, SCOPE_MCP_PUBLIC)).toBe(true);
    }
  });

  it("denies every org-scoped / write / execute tool", () => {
    for (const tool of FORBIDDEN_TOOLS) {
      expect(PUBLIC_TOOLS.has(tool)).toBe(false);
      expect(isToolAllowed(tool, SCOPE_MCP_PUBLIC)).toBe(false);
    }
  });

  it("excludes the org-scoped read traps that masquerade as read-only", () => {
    expect(PUBLIC_TOOLS.has("validate_workflow")).toBe(false);
    expect(PUBLIC_TOOLS.has("prepare_test_pin_data")).toBe(false);
    expect(PUBLIC_TOOLS.has("list_integrations")).toBe(false);
    expect(PUBLIC_TOOLS.has("get_wallet_integration")).toBe(false);
  });

  it("never escalates even if another scope is concatenated onto mcp:public", () => {
    expect(isToolAllowed("delete_workflow", "mcp:public mcp:admin")).toBe(
      false
    );
    expect(isToolAllowed("execute_transfer", "mcp:public mcp:write")).toBe(
      false
    );
  });

  it("denies unknown tools", () => {
    expect(isToolAllowed("__does_not_exist__", SCOPE_MCP_PUBLIC)).toBe(false);
  });
});

describe("publicToolRegistrar — no catalog leak in tools/list", () => {
  it("forwards public tool registrations and drops every other tool", () => {
    const tool = vi.fn();
    const wrapped = publicToolRegistrar({
      tool,
    } as unknown as Parameters<typeof publicToolRegistrar>[0]);
    // The SDK's tool() overloads are irrelevant to the registration filter;
    // call through a permissive signature so the test exercises runtime names.
    const register = wrapped.tool as unknown as (
      name: string,
      ...args: unknown[]
    ) => void;

    const noop = (): Record<string, never> => ({});
    register("search_workflows", "desc", {}, {}, noop);
    register("call_workflow", "desc", {}, {}, noop);
    register("delete_workflow", "desc", {}, {}, noop);
    register("execute_transfer", "desc", {}, {}, noop);
    register("get_wallet_integration", "desc", {}, {}, noop);

    const registered = tool.mock.calls.map((call) => call[0]);
    expect(registered).toContain("search_workflows");
    expect(registered).toContain("call_workflow");
    expect(registered).not.toContain("delete_workflow");
    expect(registered).not.toContain("execute_transfer");
    expect(registered).not.toContain("get_wallet_integration");
  });
});
