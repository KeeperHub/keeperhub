import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_MCP_TOOLS,
  DEPRECATED_TOOL_ALIASES,
  getAuthenticatedToolsForDiscovery,
} from "@/lib/mcp/mcp-tool-catalog";

vi.mock("server-only", () => ({}));

describe("mcp-tool-catalog", () => {
  it("includes get_execution and deprecated execution aliases", () => {
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution");
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution_logs");
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution_status");
    expect(DEPRECATED_TOOL_ALIASES.get_execution_logs).toBe("get_execution");
  });

  it("includes new PR2 agent tools", () => {
    for (const name of [
      "validate_cron",
      "list_executions",
      "get_spending_limits",
      "test_notification",
      "tempo_sign_and_hold",
      "tempo_cancel_hold",
      "tempo_release_hold",
    ]) {
      expect(AUTHENTICATED_MCP_TOOLS).toContain(name);
    }
  });

  it("AUTHENTICATED_MCP_TOOLS is alphabetically sorted with no duplicates", () => {
    expect(AUTHENTICATED_MCP_TOOLS).toEqual(
      [...AUTHENTICATED_MCP_TOOLS].sort()
    );
    expect(new Set(AUTHENTICATED_MCP_TOOLS).size).toBe(
      AUTHENTICATED_MCP_TOOLS.length
    );
  });

  it("getAuthenticatedToolsForDiscovery returns a copy of the catalog", () => {
    const tools = getAuthenticatedToolsForDiscovery();
    expect(tools).toEqual([...AUTHENTICATED_MCP_TOOLS]);
    expect(tools).not.toBe(AUTHENTICATED_MCP_TOOLS);
  });

  it("registered tool names match AUTHENTICATED_MCP_TOOLS", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools, registerMetaTools } = await import(
      "@/lib/mcp/tools"
    );
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    registerMetaTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );

    const registered = new Set(tools.map((t) => t.name));
    const catalog = new Set(AUTHENTICATED_MCP_TOOLS);
    expect(registered).toEqual(catalog);
  });
});

type CapturedTool = {
  name: string;
};

function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  const server = {
    tool: vi.fn((name: string) => {
      tools.push({ name });
    }),
  };
  return { server, tools };
}
