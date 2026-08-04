import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  schema: Record<string, unknown>;
  annotations: { destructiveHint?: boolean };
  handler: (...args: unknown[]) => unknown;
};

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function jsonOkResponse(body: Record<string, unknown>): unknown {
  return {
    ok: true,
    status: 202,
    statusText: "Accepted",
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
    Promise.resolve(
      jsonOkResponse({ executionId: "exec_1", status: "completed" })
    )
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function getTool(name: string): RegisteredTool {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        toolName: string,
        _description: string,
        schema: Record<string, unknown>,
        annotations: { destructiveHint?: boolean },
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name: toolName, schema, annotations, handler });
      }
    ),
  } as unknown as McpServer;

  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);
  const tool = registeredTools.find((registered) => registered.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

async function callThroughMcp(
  name: string,
  args: Record<string, unknown>
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
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

  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP direct execution simulation", () => {
  it("exposes simulate on every direct write tool", () => {
    for (const name of [
      "execute_transfer",
      "execute_contract_call",
      "execute_check_and_execute",
    ]) {
      expect(Object.keys(getTool(name).schema)).toContain("simulate");
    }
  });

  it("forwards simulate to transfer requests", async () => {
    const result = await callThroughMcp("execute_transfer", {
      chain_id: "84532",
      to_address: "0xabc",
      amount: "0.01",
      simulate: true,
    });

    expect(result.isError).not.toBe(true);
    expect(lastBody().simulate).toBe(true);
  });

  it("forwards simulate to contract-call requests", async () => {
    const result = await callThroughMcp("execute_contract_call", {
      contract_address: "0xcontract",
      chain_id: "84532",
      function_name: "transfer",
      simulate: true,
    });

    expect(result.isError).not.toBe(true);
    expect(lastBody().simulate).toBe(true);
  });

  it("forwards simulate to check-and-execute requests", async () => {
    const result = await callThroughMcp("execute_check_and_execute", {
      contract_address: "0xcheck",
      chain_id: "84532",
      function_name: "balanceOf",
      condition: { operator: "gt", value: "0" },
      action: {
        contract_address: "0xaction",
        function_name: "transfer",
      },
      simulate: true,
    });

    expect(result.isError).not.toBe(true);
    expect(lastBody().simulate).toBe(true);
  });

  it("marks contract calls as potentially destructive", () => {
    expect(getTool("execute_contract_call").annotations.destructiveHint).toBe(
      true
    );
  });

  it("keeps existing broadcast requests unchanged when simulate is omitted", async () => {
    await getTool("execute_transfer").handler({
      chain_id: "84532",
      to_address: "0xabc",
      amount: "0.01",
    });

    expect(lastBody()).not.toHaveProperty("simulate");
  });

  it("rejects truthy strings before they can reach the REST route", async () => {
    const result = await callThroughMcp("execute_transfer", {
      chain_id: "84532",
      to_address: "0xabc",
      amount: "0.01",
      simulate: "true",
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Solana IDs and aliases before making an API call", async () => {
    const chainIds = [
      "101",
      "103",
      "solana",
      "solana-mainnet",
      "solana-devnet",
      "solana-testnet",
      "103abc",
    ];

    for (const chain_id of chainIds) {
      const results = await Promise.all([
        callThroughMcp("execute_transfer", {
          chain_id,
          to_address: "11111111111111111111111111111111",
          amount: "0.01",
          simulate: true,
        }),
        callThroughMcp("execute_contract_call", {
          contract_address: "0xcontract",
          chain_id,
          function_name: "transfer",
          simulate: true,
        }),
        callThroughMcp("execute_check_and_execute", {
          contract_address: "0xcheck",
          chain_id,
          function_name: "balanceOf",
          condition: { operator: "gt", value: "0" },
          action: {
            contract_address: "0xaction",
            function_name: "transfer",
          },
          simulate: true,
        }),
      ]);

      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("EVM-only");
      }
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates unknown network identifiers to the REST validator", async () => {
    const result = await callThroughMcp("execute_transfer", {
      chain_id: "future-chain",
      to_address: "0xabc",
      amount: "0.01",
      simulate: true,
    });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lastBody().chainId).toBe("future-chain");
  });
});
