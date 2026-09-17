import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
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

function getTool(name: string, scope: string): RegisteredTool {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        toolName: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: RegisteredTool["handler"]
      ) => {
        registeredTools.push({ name: toolName, handler });
      }
    ),
  };
  registerTools(server as never, "http://internal", "Bearer test", scope);
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

function lastFetch(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetch was not called");
  }
  return { url: call[0] as string, init: call[1] as RequestInit };
}

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ leg: { status: "settled" } }),
      text: () => Promise.resolve("{}"),
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolve_disburse_leg MCP tool", () => {
  it("calls the self-scoped resolve route with the run key and leg index in the path", async () => {
    const tool = getTool("resolve_disburse_leg", SCOPE_MCP_WRITE);

    const result = await tool.handler({
      runKey: "payroll 2026/09",
      legIndex: 3,
      outcome: "paid",
      transactionHash: "0xabc",
      note: "Found it on Basescan",
    });

    const { url, init } = lastFetch();
    expect(url).toBe(
      "http://internal/api/organizations/self/disbursement-legs/payroll%202026%2F09/3/resolve"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      outcome: "paid",
      transactionHash: "0xabc",
      note: "Found it on Basescan",
    });
    expect(result.isError).toBeUndefined();
  });

  it("is refused for a read-only scope", async () => {
    const tool = getTool("resolve_disburse_leg", SCOPE_MCP_READ);

    const result = await tool.handler({
      runKey: "payroll",
      legIndex: 0,
      outcome: "not_paid",
      note: "n",
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
