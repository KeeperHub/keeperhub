import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPRECATED_PREFIX_EXECUTION } from "@/lib/mcp/mcp-tool-catalog";

vi.mock("server-only", () => ({}));

const { mockResolveExecutionViewAccess } = vi.hoisted(() => ({
  mockResolveExecutionViewAccess: vi.fn(),
}));

vi.mock("@/lib/workflow/execution-access", () => ({
  resolveExecutionViewAccess: mockResolveExecutionViewAccess,
}));

// Top-level regex constants per Biome useTopLevelRegex rule.
const STATUS_PATH_RE = /\/api\/workflows\/executions\/exec-1\/status$/;
const LOGS_PATH_RE = /\/api\/workflows\/executions\/exec-1\/logs(\?|$)/;
const STATUS_PATH_EXEC2_RE = /\/api\/workflows\/executions\/exec-2\/status$/;
const LOGS_QUERY_EXEC2_RE = /\/api\/workflows\/executions\/exec-2\/logs\?/;
const DEPRECATED_PREFIX_TEMPLATE =
  "[DEPRECATED — will be removed in v1.13. Use get_workflow instead.]";
const DEPRECATED_PREFIX_PLUGINS =
  "[DEPRECATED — will be removed in v1.13. Use list_action_schemas instead.]";

type CapturedTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  options: unknown;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        tools.push({ name, description, schema, options, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, tools };
}

// ---------------------------------------------------------------------------
// METATOOL-01, METATOOL-02: registration presence / absence
// ---------------------------------------------------------------------------

describe("Phase 50 — get_execution merger registration (METATOOL-01, METATOOL-02)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test 1: registerTools registers get_execution_status as deprecated alias", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const alias = tools.find((t) => t.name === "get_execution_status");
    if (!alias) {
      throw new Error("get_execution_status not registered");
    }
    expect(alias.description.startsWith(DEPRECATED_PREFIX_EXECUTION)).toBe(
      true
    );
  });

  it("Test 2: registerTools registers get_execution_logs as deprecated alias", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const alias = tools.find((t) => t.name === "get_execution_logs");
    if (!alias) {
      throw new Error("get_execution_logs not registered");
    }
    expect(alias.description.startsWith(DEPRECATED_PREFIX_EXECUTION)).toBe(
      true
    );
  });

  it("Test 3: registerTools registers get_execution exactly once", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const matches = tools.filter((t) => t.name === "get_execution");
    expect(matches).toHaveLength(1);
  });

  it("Test 4: get_execution has exactly 4 Zod params: executionId, includeData, nodeIds, truncateData", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const getExec = tools.find((t) => t.name === "get_execution");
    if (!getExec) {
      throw new Error("get_execution not registered");
    }
    const keys = Object.keys(getExec.schema).sort();
    expect(keys).toEqual([
      "executionId",
      "includeData",
      "nodeIds",
      "truncateData",
    ]);
  });
});

// ---------------------------------------------------------------------------
// METATOOL-01: handler combines /status + /logs into { status, logs }
// ---------------------------------------------------------------------------

describe("Phase 50 — get_execution handler combines /status + /logs in one envelope", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveExecutionViewAccess.mockReset();
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "full",
      execution: { id: "exec-1", workflow: { id: "wf_1" } },
    });
  });

  it("Test 5: no-params invocation calls /status then /logs sequentially and returns { status, logs }", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ executionStatus: "completed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/logs")) {
        return new Response(JSON.stringify({ logs: [{ nodeId: "n1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const getExec = tools.find((t) => t.name === "get_execution");
    if (!getExec) {
      throw new Error("get_execution not registered");
    }

    const result = (await getExec.handler({ executionId: "exec-1" })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => STATUS_PATH_RE.test(u))).toBe(true);
    expect(urls.some((u) => LOGS_PATH_RE.test(u))).toBe(true);
    expect(urls.findIndex((u) => STATUS_PATH_RE.test(u))).toBeLessThan(
      urls.findIndex((u) => LOGS_PATH_RE.test(u))
    );

    const parsed = JSON.parse(result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("logs");

    vi.unstubAllGlobals();
  });

  it("Test 6: Phase 46 params forwarded to /logs query string; /status URL has no query", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "full",
      execution: { id: "exec-2", workflow: { id: "wf_2" } },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/status")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const getExec = tools.find((t) => t.name === "get_execution");
    if (!getExec) {
      throw new Error("get_execution not registered");
    }

    await getExec.handler({
      executionId: "exec-2",
      includeData: false,
      nodeIds: ["nodeA", "nodeB"],
      truncateData: 500,
    });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const statusUrl = urls.find((u) => STATUS_PATH_EXEC2_RE.test(u));
    const logsUrl = urls.find((u) => LOGS_QUERY_EXEC2_RE.test(u));
    if (!(statusUrl && logsUrl)) {
      throw new Error(`Expected both URLs; got ${urls.join(", ")}`);
    }

    expect(statusUrl).not.toContain("?");
    expect(logsUrl).toContain("includeData=false");
    expect(logsUrl).toContain("nodeIds=nodeA");
    expect(logsUrl).toContain("nodeIds=nodeB");
    expect(logsUrl).toContain("truncateData=500");

    vi.unstubAllGlobals();
  });

  it("keeps the { status, logs } envelope for a publicly shared execution", async () => {
    // The response shape must not depend on ownership: a client that reads
    // result.logs against its own execution would otherwise silently see
    // undefined (and report zero steps) the first time it is pointed at a
    // shared one. logs is null -- withheld, not empty.
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution: { id: "exec-3", workflow: { id: "wf_3" } },
    });

    const fetchMock = vi.fn(
      () =>
        new Response(JSON.stringify({ status: "running" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const getExec = tools.find((t) => t.name === "get_execution");
    if (!getExec) {
      throw new Error("get_execution not registered");
    }

    const result = (await getExec.handler({ executionId: "exec-3" })) as {
      content: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as Record<
      string,
      unknown
    >;

    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("logs");
    expect(parsed.logs).toBeNull();
    // Only the status endpoint is reachable on this path.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// METATOOL-03: deprecated aliases are still registered with v1.13 prefix
// ---------------------------------------------------------------------------

describe("Phase 50 — get_template and search_plugins are deprecated aliases (METATOOL-03)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test 7: get_template is still registered AND description starts with [DEPRECATED — will be removed in v1.13. Use get_workflow instead.]", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const tmpl = tools.find((t) => t.name === "get_template");
    if (!tmpl) {
      throw new Error("get_template not registered (must remain functional)");
    }
    expect(tmpl.description.startsWith(DEPRECATED_PREFIX_TEMPLATE)).toBe(true);
  });

  it("Test 8: search_plugins is still registered AND description starts with [DEPRECATED — will be removed in v1.13. Use list_action_schemas instead.]", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(server, "http://localhost:3000", "Bearer test-token");
    const plug = tools.find((t) => t.name === "search_plugins");
    if (!plug) {
      throw new Error("search_plugins not registered (must remain functional)");
    }
    expect(plug.description.startsWith(DEPRECATED_PREFIX_PLUGINS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OAuth scope wiring after Phase 50 merger
// ---------------------------------------------------------------------------

describe("Phase 50 — OAuth scope wiring after merger", () => {
  it("Test 9: scope gates correctly route get_execution + allow deprecated aliases + preserve get_direct_execution_status", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("get_execution", "mcp:read")).toBe(true);
    expect(isToolAllowed("get_execution_status", "mcp:read")).toBe(true);
    expect(isToolAllowed("get_execution_logs", "mcp:read")).toBe(true);
    expect(isToolAllowed("get_direct_execution_status", "mcp:read")).toBe(true);
    expect(isToolAllowed("get_template", "mcp:read")).toBe(true);
    expect(isToolAllowed("search_plugins", "mcp:read")).toBe(true);
    expect(isToolAllowed("validate_cron", "mcp:read")).toBe(true);
    expect(isToolAllowed("list_executions", "mcp:read")).toBe(true);
    expect(isToolAllowed("test_notification", "mcp:write")).toBe(true);
    expect(isToolAllowed("tempo_sign_and_hold", "mcp:write")).toBe(true);
  });
});
