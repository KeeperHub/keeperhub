import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerMetaTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function registerExecuteProtocolTool(): RegisteredTool {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        _annotations: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        registeredTools.push({ name, description, schema, handler });
      }
    ),
  } as unknown as McpServer;

  registerMetaTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const tool = registeredTools.find(
    (registered) => registered.name === "execute_protocol_action"
  );
  if (!tool) {
    throw new Error("execute_protocol_action not registered");
  }
  return tool;
}

function lastFetchInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetch was not called");
  }
  return call[1] as RequestInit;
}

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ success: true }),
      text: () => Promise.resolve("{}"),
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("execute_protocol_action idempotency", () => {
  it("registers an optional idempotency_key and mentions retry-with-same-key", () => {
    const tool = registerExecuteProtocolTool();

    expect(tool.schema).toHaveProperty("idempotency_key");
    expect(tool.description.toLowerCase()).toContain("idempotency_key");
  });

  it("forwards idempotency_key as Idempotency-Key and does not put it in the body", async () => {
    const tool = registerExecuteProtocolTool();
    const params = { chainId: 8453, amount: "1000" };

    await tool.handler({
      actionType: "aave-v3/supply",
      params,
      idempotency_key: "protocol-key-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://internal/api/execute/aave-v3/supply");

    const init = lastFetchInit();
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "protocol-key-1",
    });
    expect(init.signal).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual(params);
    expect(JSON.parse(String(init.body))).not.toHaveProperty("idempotency_key");
  });

  it("omits Idempotency-Key when idempotency_key is not provided", async () => {
    const tool = registerExecuteProtocolTool();

    await tool.handler({
      actionType: "chronicle/eth-usd-read",
      params: { chainId: 1 },
    });

    const init = lastFetchInit();
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });
});
