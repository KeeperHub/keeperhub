import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Declared before vi.mock so the hoisted factory closes over them.
const workflowTools: CapturedTool[] = [];

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  const MockMcpServer = vi.fn(function (this: {
    registerTool: (
      name: string,
      config: unknown,
      handler: (...args: unknown[]) => unknown
    ) => void;
  }) {
    this.registerTool = (name, _config, handler) => {
      workflowTools.push({ name, handler });
    };
  });
  const MockResourceTemplate = vi.fn(function (this: unknown) {
    return this;
  });
  return { McpServer: MockMcpServer, ResourceTemplate: MockResourceTemplate };
});

const RATE_LIMITED_BODY = JSON.stringify({ error: "Rate limit exceeded" });

function rateLimited(headers: Record<string, string>): Response {
  return new Response(RATE_LIMITED_BODY, {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("buildApiCallFailedError", () => {
  it("appends the Retry-After token on a 429 that carries the header", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const error = buildApiCallFailedError(
      rateLimited({ "Retry-After": "30" }),
      RATE_LIMITED_BODY
    );
    expect(error.message).toBe(
      'API call failed: 429 Too Many Requests (Retry-After: 30s) - {"error":"Rate limit exceeded"}'
    );
  });

  it("omits the token on a 429 without the header", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const error = buildApiCallFailedError(rateLimited({}), RATE_LIMITED_BODY);
    expect(error.message).toBe(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });

  it("omits the token on a 429 whose header cannot be parsed", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const error = buildApiCallFailedError(
      rateLimited({ "Retry-After": "whenever" }),
      RATE_LIMITED_BODY
    );
    expect(error.message).toBe(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });

  it("keeps a zero-second wait rather than dropping it", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const error = buildApiCallFailedError(
      rateLimited({ "Retry-After": "0" }),
      RATE_LIMITED_BODY
    );
    expect(error.message).toBe(
      'API call failed: 429 Too Many Requests (Retry-After: 0s) - {"error":"Rate limit exceeded"}'
    );
  });

  it("ignores a Retry-After header on a non-429 status", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const response = new Response("Service Unavailable", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Retry-After": "30" },
    });
    const error = buildApiCallFailedError(response, "Service Unavailable");
    expect(error.message).toBe(
      "API call failed: 503 Service Unavailable - Service Unavailable"
    );
  });

  it("emits the status alone when statusText is empty", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const response = new Response("nope", { status: 418, statusText: "" });
    const error = buildApiCallFailedError(response, "nope");
    expect(error.message).toBe("API call failed: 418 - nope");
  });

  it("emits the status alone plus the token when a 429 has empty statusText", async () => {
    const { buildApiCallFailedError } = await import(
      "@/lib/mcp/api-call-error"
    );
    const response = new Response(RATE_LIMITED_BODY, {
      status: 429,
      statusText: "",
      headers: { "Retry-After": "12" },
    });
    const error = buildApiCallFailedError(response, RATE_LIMITED_BODY);
    expect(error.message).toBe(
      'API call failed: 429 (Retry-After: 12s) - {"error":"Rate limit exceeded"}'
    );
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses integer seconds", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("rounds fractional seconds up", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    expect(parseRetryAfterSeconds("2.4")).toBe(3);
  });

  it("returns null for an absent or empty header", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("")).toBeNull();
  });

  it("returns null rather than fabricating a wait for unusable values", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    expect(parseRetryAfterSeconds("invalid-duration")).toBeNull();
    expect(parseRetryAfterSeconds("-5")).toBeNull();
  });

  it("turns an HTTP-date into the remaining seconds", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    const futureDate = new Date(Date.now() + 15_000).toUTCString();
    const result = parseRetryAfterSeconds(futureDate);
    expect(result).toBeGreaterThanOrEqual(14);
    expect(result).toBeLessThanOrEqual(16);
  });

  it("floors a past HTTP-date at one second", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/api-call-error");
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(pastDate)).toBe(1);
  });
});

describe("MCP tool callApi 429 handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("surfaces Retry-After seconds in the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({ "Retry-After": "30" })))
    );

    await expect(callListExecutions()).rejects.toThrow(
      'API call failed: 429 Too Many Requests (Retry-After: 30s) - {"error":"Rate limit exceeded"}'
    );
  });

  it("omits the token when the 429 carries no header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({})))
    );

    await expect(callListExecutions()).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });

  it("omits the token when the header is unparseable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(rateLimited({ "Retry-After": "not-a-number-or-date" }))
      )
    );

    await expect(callListExecutions()).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });

  it("surfaces a zero-second wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({ "Retry-After": "0" })))
    );

    await expect(callListExecutions()).rejects.toThrow(/Retry-After: 0s/);
  });

  it("leaves non-429 error messages untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          })
        )
      )
    );

    await expect(callListExecutions()).rejects.toThrow(
      "API call failed: 500 Internal Server Error - Internal Server Error"
    );
  });
});

describe("MCP resource fetchJson 429 handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("surfaces Retry-After in the error when a resource fetch is rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({ "Retry-After": "45" })))
    );

    await expect(readWorkflowsResource()).rejects.toThrow(
      'API call failed: 429 Too Many Requests (Retry-After: 45s) - {"error":"Rate limit exceeded"}'
    );
  });

  it("omits the token when the 429 carries no header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({})))
    );

    await expect(readWorkflowsResource()).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });
});

describe("MCP servers agree on the error text", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    workflowTools.length = 0;
  });

  it("produces one identical string from all three servers for the same 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited({ "Retry-After": "37" })))
    );

    const messages = [
      await captureMessage(callListExecutions),
      await captureMessage(readWorkflowsResource),
      await captureMessage(callWorkflowTool),
    ];

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(
      'API call failed: 429 Too Many Requests (Retry-After: 37s) - {"error":"Rate limit exceeded"}'
    );
  });

  it("produces one identical string from all three servers when statusText is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(RATE_LIMITED_BODY, {
            status: 429,
            statusText: "",
            headers: {
              "content-type": "application/json",
              "Retry-After": "37",
            },
          })
        )
      )
    );

    const messages = [
      await captureMessage(callListExecutions),
      await captureMessage(readWorkflowsResource),
      await captureMessage(callWorkflowTool),
    ];

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(
      'API call failed: 429 (Retry-After: 37s) - {"error":"Rate limit exceeded"}'
    );
  });
});

// Source-level like stablecoin-cap-registry.test.ts: tests/setup.ts loads the barrel itself, so no in-process check can see the route graph.
describe("shared error module keeps the per-workflow route graph clean", () => {
  const sourceOf = (relative: string): string =>
    readFileSync(join(process.cwd(), relative), "utf8");

  it("the shared module imports nothing, so it cannot drag the barrel anywhere", () => {
    expect(sourceOf("lib/mcp/api-call-error.ts")).not.toMatch(
      /^\s*(?:import|export)\b.*\bfrom\b|^\s*import\s*["']/m
    );
  });

  it("workflow-server does not import tools, which pulls the protocol barrel", () => {
    expect(sourceOf("lib/mcp/workflow-server.ts")).not.toMatch(
      /from\s+["'](?:@\/lib\/mcp\/tools|\.\/tools)["']/
    );
    expect(sourceOf("lib/mcp/tools.ts")).toMatch(
      /^import\s+["']@\/protocols["'];$/m
    );
  });

  it("workflow-server still carries the barrel import it needs for itself", () => {
    expect(sourceOf("lib/mcp/workflow-server.ts")).toMatch(
      /^import\s+["']@\/protocols["'];$/m
    );
  });
});

type CapturedTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

type CapturedResource = {
  name: string;
  uri: string;
  handler: (...args: unknown[]) => unknown;
};

async function captureMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject");
}

async function callListExecutions(): Promise<unknown> {
  const { server, tools } = makeMockServer();
  const { registerTools } = await import("@/lib/mcp/tools");
  registerTools(
    server as unknown as McpServer,
    "http://localhost:3000",
    "Bearer test-token"
  );
  const listTool = tools.find((t) => t.name === "list_executions");
  if (!listTool) {
    throw new Error("list_executions not registered");
  }
  return await listTool.handler({});
}

async function readWorkflowsResource(): Promise<unknown> {
  const { server, resources } = makeMockServer();
  const { registerResources } = await import("@/lib/mcp/server");
  registerResources(
    server as unknown as McpServer,
    "http://localhost:3000",
    "Bearer test-token"
  );
  const workflowResource = resources.find((r) => r.name === "workflows-list");
  if (!workflowResource) {
    throw new Error("workflows-list resource not registered");
  }
  return await workflowResource.handler("keeperhub://workflows");
}

async function callWorkflowTool(): Promise<unknown> {
  workflowTools.length = 0;
  const { createWorkflowMcpServer } = await import("@/lib/mcp/workflow-server");
  createWorkflowMcpServer({
    slug: "aave-position-monitor",
    listing: {
      id: "wf-001",
      name: "Aave Position Monitor",
      description: "Monitors Aave positions.",
      listedSlug: "aave-position-monitor",
      inputSchema: null,
      outputMapping: null,
      priceUsdcPerCall: null,
      workflowType: "read",
      listingVersion: 1,
      nodes: [],
    },
    internalApiBaseUrl: "http://localhost:3000",
    authHeader: "Bearer kh_test",
  });
  const tool = workflowTools[0];
  if (!tool) {
    throw new Error("workflow tool not registered");
  }
  return await tool.handler({});
}

function makeMockServer(): {
  server: {
    tool: ReturnType<typeof vi.fn>;
    resource: ReturnType<typeof vi.fn>;
  };
  tools: CapturedTool[];
  resources: CapturedResource[];
} {
  const tools: CapturedTool[] = [];
  const resources: CapturedResource[] = [];
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
    resource: vi.fn(
      (
        name: string,
        uri: string,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        resources.push({ name, uri, handler });
      }
    ),
  };
  return { server, tools, resources };
}
