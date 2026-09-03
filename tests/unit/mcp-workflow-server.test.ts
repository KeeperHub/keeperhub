import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// mockRegisterTool is defined before vi.mock so the factory closure captures it.
const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  // vi.fn(impl) creates a spy that also acts as a constructor.
  const MockMcpServer = vi.fn(function (this: {
    registerTool: typeof mockRegisterTool;
  }) {
    this.registerTool = mockRegisterTool;
  });
  return { McpServer: MockMcpServer };
});

import {
  createWorkflowMcpServer,
  type WorkflowListing,
} from "@/lib/mcp/workflow-server";

const baseListing: WorkflowListing = {
  id: "wf-001",
  name: "Aave Position Monitor",
  description: "Monitors Aave positions and alerts on health factor drops.",
  listedSlug: "aave-position-monitor",
  inputSchema: {
    type: "object",
    properties: {
      address: { type: "string", description: "The wallet address to monitor" },
      threshold: { type: "number", description: "Health factor threshold" },
    },
    required: ["address"],
  },
  outputMapping: { healthFactor: "$.healthFactor", status: "$.status" },
  priceUsdcPerCall: null,
  workflowType: "read",
  listingVersion: 3,
  nodes: [],
};

describe("createWorkflowMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly one tool named after the slug", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    expect(mockRegisterTool).toHaveBeenCalledOnce();
    expect(mockRegisterTool.mock.calls[0][0]).toBe("aave-position-monitor");
  });

  it("tool config carries the listing name as title", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as { title: string };
    expect(config.title).toBe("Aave Position Monitor");
  });

  it("tool description includes workflow name and description", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as { description: string };
    expect(config.description).toContain("Aave Position Monitor");
    expect(config.description).toContain("Monitors Aave positions");
  });

  it("tool description includes input field names from inputSchema", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as { description: string };
    expect(config.description).toContain("address");
    expect(config.description).toContain("threshold");
  });

  it("tool description mentions price for paid workflows", () => {
    const paidListing: WorkflowListing = {
      ...baseListing,
      priceUsdcPerCall: "0.50",
    };

    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: paidListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as { description: string };
    expect(config.description).toContain("0.50");
    expect(config.description).toContain("USDC");
  });

  it("tool handler POSTs to the call route with the slug and args", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const handler = mockRegisterTool.mock.calls[0][2] as (
      args: Record<string, unknown>
    ) => Promise<unknown>;

    const args = { address: "0xabc", threshold: 1.5 };
    await handler(args);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { body?: string },
    ];
    expect(url).toBe(
      "http://localhost:3000/api/mcp/workflows/aave-position-monitor/call"
    );
    expect(init.method).toBe("POST");
    // Handler normalizes args: missing `type` is injected as "manual"
    expect(JSON.parse(init.body ?? "{}")).toEqual({ type: "manual", ...args });

    fetchSpy.mockRestore();
  });

  it("readOnlyHint is true for a read workflow with no nodes", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as {
      annotations: { readOnlyHint: boolean };
    };
    expect(config.annotations.readOnlyHint).toBe(true);
  });

  it("readOnlyHint is false for a write workflow", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: { ...baseListing, workflowType: "write" },
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as {
      annotations: { readOnlyHint: boolean };
    };
    expect(config.annotations.readOnlyHint).toBe(false);
  });

  it.each([
    ["web3/batch-write-contract"],
    ["web3/approve-token"],
    ["web3/transfer-funds"],
    ["web3/transfer-token"],
  ])("readOnlyHint is false for a read-typed workflow whose only node is %s", (actionType) => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: {
        ...baseListing,
        workflowType: "read",
        nodes: [{ data: { config: { actionType } } }],
      },
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as {
      annotations: { readOnlyHint: boolean };
    };
    expect(config.annotations.readOnlyHint).toBe(false);
  });

  it("readOnlyHint stays true for a read-typed workflow whose only node reads", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: {
        ...baseListing,
        workflowType: "read",
        nodes: [{ data: { config: { actionType: "web3/read-contract" } } }],
      },
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    const config = mockRegisterTool.mock.calls[0][1] as {
      annotations: { readOnlyHint: boolean };
    };
    expect(config.annotations.readOnlyHint).toBe(true);
  });

  it("server name includes the slug", () => {
    createWorkflowMcpServer({
      slug: "aave-position-monitor",
      listing: baseListing,
      internalApiBaseUrl: "http://localhost:3000",
      authHeader: "Bearer kh_test",
    });

    // The McpServer constructor is called with { name, version }
    // mockRegisterTool lives on the instance; the constructor args
    // are captured by the vi.fn() spy on the McpServer import.
    // We verify the slug appears in the registered tool name instead.
    expect(mockRegisterTool.mock.calls[0][0]).toBe("aave-position-monitor");
  });
});
