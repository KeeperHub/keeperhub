import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("MCP agent utility tool handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("list_executions forwards Bearer auth to analytics runs", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ runs: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer oauth-token"
    );
    const tool = tools.find((t) => t.name === "list_executions");
    if (!tool) {
      throw new Error("list_executions not registered");
    }

    await tool.handler({ limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/analytics/runs"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
        }),
      })
    );
  });

  it("list_executions surfaces 401 from analytics runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 }))
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer oauth-token"
    );
    const tool = tools.find((t) => t.name === "list_executions");
    if (!tool) {
      throw new Error("list_executions not registered");
    }

    await expect(tool.handler({})).rejects.toThrow(/401/);
  });

  it("get_spending_limits calls spend-cap endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          dailyCapWei: "1000",
          dailyUsedWei: "0",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer oauth-token"
    );
    const tool = tools.find((t) => t.name === "get_spending_limits");
    if (!tool) {
      throw new Error("get_spending_limits not registered");
    }

    const result = (await tool.handler({})) as {
      content: Array<{ text: string }>;
    };
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/analytics/spend-cap"),
      expect.any(Object)
    );
    const parsed = JSON.parse(result.content[0].text) as {
      dailyCapWei: string;
    };
    expect(parsed.dailyCapWei).toBe("1000");
  });

  it("tempo_release_hold rethrows 403 errors from the broadcast route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
      )
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer oauth-token"
    );
    const tool = tools.find((t) => t.name === "tempo_release_hold");
    if (!tool) {
      throw new Error("tempo_release_hold not registered");
    }

    await expect(tool.handler({ paymentId: "pay-1" })).rejects.toThrow(/403/);
  });
});

type CapturedTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        tools.push({ name, handler });
      }
    ),
  };
  return { server, tools };
}
