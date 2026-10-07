import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function registerTopUpGasTool(): RegisteredTool {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        annotations: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        registeredTools.push({
          name,
          description,
          schema,
          annotations,
          handler,
        });
      }
    ),
  } as unknown as McpServer;

  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const tool = registeredTools.find(
    (registered) => registered.name === "top_up_gas"
  );
  if (!tool) {
    throw new Error("top_up_gas not registered");
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
      status: 202,
      statusText: "Accepted",
      headers: { get: () => "application/json" },
      json: () =>
        Promise.resolve({ executionId: "exec-1", status: "completed" }),
      text: () => Promise.resolve("{}"),
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("top_up_gas MCP tool", () => {
  it("exposes chain_id, amount_usdc and idempotency_key, and no recipient or slippage", () => {
    const tool = registerTopUpGasTool();

    expect(Object.keys(tool.schema).sort()).toEqual([
      "amount_usdc",
      "chain_id",
      "idempotency_key",
    ]);
  });

  it("is annotated as destructive", () => {
    const tool = registerTopUpGasTool();

    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("posts chainId and amountUsdc to /api/execute/gas-top-up", async () => {
    const tool = registerTopUpGasTool();

    await tool.handler({ chain_id: "8453", amount_usdc: "5" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://internal/api/execute/gas-top-up"
    );
    const init = lastFetchInit();
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      chainId: "8453",
      amountUsdc: "5",
    });
  });

  it("forwards idempotency_key as Idempotency-Key, not in the body, with no client timeout", async () => {
    const tool = registerTopUpGasTool();

    await tool.handler({
      chain_id: "8453",
      amount_usdc: "5",
      idempotency_key: "top-up-key-1",
    });

    const init = lastFetchInit();
    expect(init.headers).toMatchObject({ "Idempotency-Key": "top-up-key-1" });
    expect(init.signal).toBeUndefined();
    expect(JSON.parse(String(init.body))).not.toHaveProperty("idempotency_key");
  });

  it("omits Idempotency-Key when idempotency_key is not provided", async () => {
    const tool = registerTopUpGasTool();

    await tool.handler({ chain_id: "1", amount_usdc: "1" });

    const headers = lastFetchInit().headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });
});
