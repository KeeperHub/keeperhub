import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  parseRunFilters,
  VALID_STATUSES,
} from "@/lib/analytics/parse-run-filters";

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

  it("describes the run listing with the numbers and statuses the route keeps", async () => {
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

    // The description is a contract the handler does not enforce. It said a
    // default of 20 while the run query defaulted to 50, and it omitted
    // `skipped` while the parser accepted it - so an agent that believed the
    // description under-fetched, and one that wanted skipped rows was told the
    // status did not exist. Both now read from the modules that apply them.
    const limitText = descriptionOf(tool.schema.limit);
    expect(limitText).toContain(`default ${DEFAULT_RUN_PAGE_SIZE}`);
    expect(limitText).toContain(`max ${MAX_RUN_PAGE_SIZE}`);

    const expectedStatuses = [...VALID_STATUSES].join(", ");
    const statusText = descriptionOf(tool.schema.status);
    expect(statusText).toBe(`Filter by status: ${expectedStatuses}`);

    // And every status it names selects rows: the parser drops values it does
    // not know, so a listed value it drops is a value an agent cannot use even
    // though the description offers it.
    const listed = statusText.replace("Filter by status: ", "").split(", ");
    for (const status of listed) {
      const params = new URLSearchParams();
      params.append("status", status);
      expect(parseRunFilters(params).statuses).toContain(status);
    }
    expect(listed).toContain("skipped");
  });
});

type CapturedTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
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
        description: string,
        schema: Record<string, unknown>,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        tools.push({ name, description, schema, handler });
      }
    ),
  };
  return { server, tools };
}

/**
 * The text a zod field was given with `.describe()`. Read through both shapes
 * because zod keeps it on the schema in one version and under `_def` in another,
 * and this test should not be the thing that breaks on that upgrade.
 */
function descriptionOf(schema: unknown): string {
  const candidate = schema as {
    description?: string;
    _def?: { description?: string };
  };
  return candidate.description ?? candidate._def?.description ?? "";
}
