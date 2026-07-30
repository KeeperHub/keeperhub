/**
 * The direct-execution REST routes accept a `simulate` dry-run flag (parsed by
 * app/api/execute/_lib/simulate-flag.ts), but the MCP tools never exposed it,
 * so an agent driving KeeperHub over MCP had no way to check a call before
 * broadcasting it.
 *
 * `simulate` is deliberately typed as a real boolean rather than the string
 * encoding the other scalars use: parseSimulateFlag rejects strings and numbers
 * outright so a mistyped "false" can never fall through to a live broadcast.
 *
 * Coverage mirrors mcp-execute-field-naming.test.ts:
 *   - Handler level: the flag is in each schema and reaches the route body,
 *     and is omitted (not sent as null) when the caller leaves it out.
 *   - SDK level: a real Client <-> McpServer pair over an in-memory transport,
 *     so the MCP SDK's own Zod validation accepts a boolean and rejects the
 *     string form before the handler runs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
};

type FetchMock = ReturnType<typeof vi.fn>;

const VALIDATION_ERROR_PATTERN = /required|Invalid arguments|validation/i;

const EXECUTE_TOOLS = [
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
] as const;

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

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetch was not called");
  }
  const init = call[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(jsonOkResponse({ simulated: true, gasEstimate: "21000" }))
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Handler level
// ---------------------------------------------------------------------------

function makeMockServer(): {
  server: McpServer;
  registeredTools: RegisteredTool[];
} {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        schema: Record<string, unknown>,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, schema, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

function getTool(name: string): RegisteredTool {
  const { server, registeredTools } = makeMockServer();
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  execute_transfer: {
    chain_id: "8453",
    to_address: "0xabc",
    amount: "0.1",
  },
  execute_contract_call: {
    contract_address: "0xc",
    chain_id: "11155111",
    function_name: "foo",
  },
  execute_check_and_execute: {
    contract_address: "0xc",
    chain_id: "42161",
    function_name: "baz",
    condition: { operator: "gt", value: "1000" },
    action: { contract_address: "0xa", function_name: "bar" },
  },
};

describe("MCP execute tools expose the simulate dry-run flag", () => {
  it.each(EXECUTE_TOOLS)("%s schema declares simulate", (name) => {
    expect(Object.keys(getTool(name).schema)).toContain("simulate");
  });

  it.each(EXECUTE_TOOLS)(
    "%s forwards simulate: true to the route body",
    async (name) => {
      await getTool(name).handler({ ...MINIMAL_ARGS[name], simulate: true });
      expect(lastBody().simulate).toBe(true);
    }
  );

  it.each(EXECUTE_TOOLS)(
    "%s forwards simulate: false explicitly when the caller opts out",
    async (name) => {
      await getTool(name).handler({ ...MINIMAL_ARGS[name], simulate: false });
      expect(lastBody().simulate).toBe(false);
    }
  );

  it.each(EXECUTE_TOOLS)(
    "%s omits simulate when the caller leaves it out, so the route default applies",
    async (name) => {
      await getTool(name).handler({ ...MINIMAL_ARGS[name] });
      expect(lastBody().simulate).toBeUndefined();
    }
  );

  it("execute_check_and_execute keeps simulate at the top level, not inside action", async () => {
    await getTool("execute_check_and_execute").handler({
      ...MINIMAL_ARGS.execute_check_and_execute,
      simulate: true,
    });
    const body = lastBody();
    expect(body.simulate).toBe(true);
    expect(body.action).not.toHaveProperty("simulate");
  });
});

// ---------------------------------------------------------------------------
// SDK level - real Client <-> McpServer over an in-memory transport, so the
// MCP SDK's Zod validation runs the full tools/call path.
// ---------------------------------------------------------------------------

type ConnectedClient = { client: Client; close: () => Promise<void> };

async function connectedClient(): Promise<ConnectedClient> {
  const server = new McpServer({ name: "simulate-test", version: "0.0.0" });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "simulate-test-client",
    version: "0.0.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

describe("MCP execute tools simulate flag - SDK level", () => {
  it("accepts a boolean simulate through SDK validation", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = (await client.callTool({
        name: "execute_contract_call",
        arguments: {
          ...MINIMAL_ARGS.execute_contract_call,
          simulate: true,
        },
      })) as ToolCallResult;

      expect(result.isError).toBeFalsy();
      expect(lastBody().simulate).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects the string form before the handler runs, so no request is sent", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = (await client.callTool({
        name: "execute_contract_call",
        // parseSimulateFlag would 400 on this anyway; failing at the schema
        // keeps the round trip off the wire entirely.
        arguments: {
          ...MINIMAL_ARGS.execute_contract_call,
          simulate: "true",
        },
      })) as ToolCallResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(VALIDATION_ERROR_PATTERN);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
