import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function getTool(name: string): RegisteredTool {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        toolName: string,
        _description: string,
        _schema: Record<string, unknown>,
        _annotations: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        registeredTools.push({ name: toolName, handler });
      }
    ),
  };

  registerTools(
    server as never,
    "http://internal",
    "Bearer test",
    SCOPE_MCP_WRITE
  );
  const tool = registeredTools.find((registered) => registered.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
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
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve("{}"),
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP Tempo tools", () => {
  it("tempo_sign_and_hold forwards idempotency key and disables fetch timeout", async () => {
    await getTool("tempo_sign_and_hold").handler({
      network: "tempo-testnet",
      tokenConfig: "usdc",
      amount: "1",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      idempotency_key: "hold-key-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = lastFetchInit();
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "hold-key-1",
    });
    expect(init.signal).toBeUndefined();
    expect(JSON.parse(String(init.body))).not.toHaveProperty("idempotency_key");
  });

  it("tempo_release_hold forwards idempotency key and disables fetch timeout", async () => {
    await getTool("tempo_release_hold").handler({
      paymentId: "hp-1",
      idempotency_key: "release-key-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = lastFetchInit();
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "release-key-1",
    });
    expect(init.signal).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/tempo/held-payments/hp-1/broadcast"
    );
  });

  it("tempo_release_hold surfaces API errors without a session_required special case", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { get: () => "application/json" },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: "Only organization owners can release held payments.",
          })
        ),
    });

    await expect(
      getTool("tempo_release_hold").handler({ paymentId: "hp-1" })
    ).rejects.toThrow(/403/);
  });

  it("test_notification calls the integrations test endpoint", async () => {
    await getTool("test_notification").handler({
      type: "discord",
      config: { webhookUrl: "https://example.com/hook" },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://internal/api/integrations/test"
    );
    expect(JSON.parse(String(lastFetchInit().body))).toEqual({
      type: "discord",
      config: { webhookUrl: "https://example.com/hook" },
    });
  });

  it("tempo_cancel_hold calls the cancel endpoint", async () => {
    await getTool("tempo_cancel_hold").handler({ paymentId: "hp-9" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://internal/api/tempo/held-payments/hp-9/cancel"
    );
  });
});

describe("MCP timeout exemptions", () => {
  it("get_direct_execution_status uses the default fetch timeout", async () => {
    await getTool("get_direct_execution_status").handler({
      execution_id: "exec-1",
    });

    const init = lastFetchInit();
    expect(init.signal).toBeDefined();
  });

  it("ai_generate_workflow disables timeout while staying cold-start aware", async () => {
    await getTool("ai_generate_workflow").handler({
      prompt: "Monitor USDC transfers",
    });

    const init = lastFetchInit();
    expect(init.signal).toBeUndefined();
  });
});
