import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("MCP callApi cold-start handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("create_workflow surfaces retry hint on 504 with Retry-After", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Gateway Timeout", {
        status: 504,
        headers: { "Retry-After": "45" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const createTool = tools.find((t) => t.name === "create_workflow");
    if (!createTool) {
      throw new Error("create_workflow not registered");
    }

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/upstream_cold_start/);

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/45/);
  });

  it("create_workflow surfaces retry hint on 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad Gateway", { status: 502 }))
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const createTool = tools.find((t) => t.name === "create_workflow");
    if (!createTool) {
      throw new Error("create_workflow not registered");
    }

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/upstream_cold_start/);
  });

  it("create_workflow surfaces retry hint on 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service Unavailable", { status: 503 }))
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const createTool = tools.find((t) => t.name === "create_workflow");
    if (!createTool) {
      throw new Error("create_workflow not registered");
    }

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
      })
    ).rejects.toThrow(/upstream_cold_start/);
  });

  it("ai_generate_workflow surfaces retry hint on 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Gateway Timeout", { status: 504 }))
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const tool = tools.find((t) => t.name === "ai_generate_workflow");
    if (!tool) {
      throw new Error("ai_generate_workflow not registered");
    }

    await expect(tool.handler({ prompt: "Build a workflow" })).rejects.toThrow(
      /upstream_cold_start/
    );
  });

  it("fetch connection errors are not reported as upstream_cold_start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const createTool = tools.find((t) => t.name === "create_workflow");
    if (!createTool) {
      throw new Error("create_workflow not registered");
    }

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/fetch failed/);
    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.not.toThrow(/upstream_cold_start/);
  });

  it("non-cold-start-aware tool throws plain error on 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Gateway Timeout", { status: 504 }))
    );

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const tool = tools.find((t) => t.name === "list_executions");
    if (!tool) {
      throw new Error("list_executions not registered");
    }

    await expect(tool.handler({})).rejects.toThrow(/API call failed: 504/);
    await expect(tool.handler({})).rejects.not.toThrow(/upstream_cold_start/);
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
