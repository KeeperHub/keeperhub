/**
 * KH-3: `delete_workflow` on a workflow with execution history returns a 409
 * that says "delete executions first" - but no tool exists to do that, and
 * the underlying route already supports a `?force=true` cascade the MCP tool
 * never forwarded. This pins the MCP-layer argument through to the query
 * string the route actually reads.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function jsonOkResponse(body: Record<string, unknown>): unknown {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  };
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(jsonOkResponse({ success: true })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function callDeleteWorkflow(
  args: Record<string, unknown>
): Promise<void> {
  const server = new McpServer({
    name: "delete-workflow-test",
    version: "0.0.0",
  });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "delete-workflow-test-client",
    version: "0.0.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({ name: "delete_workflow", arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function requestedUrl(): string {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetch was not called");
  }
  return call[0] as string;
}

describe("delete_workflow force parameter", () => {
  it("omits force from the query string when not passed", async () => {
    await callDeleteWorkflow({ workflowId: "wf_1" });
    expect(requestedUrl()).toBe("http://internal/api/workflows/wf_1");
  });

  it("omits force from the query string when explicitly false", async () => {
    await callDeleteWorkflow({ workflowId: "wf_1", force: false });
    expect(requestedUrl()).toBe("http://internal/api/workflows/wf_1");
  });

  it("appends ?force=true when force is true", async () => {
    await callDeleteWorkflow({ workflowId: "wf_1", force: true });
    expect(requestedUrl()).toBe(
      "http://internal/api/workflows/wf_1?force=true"
    );
  });
});
