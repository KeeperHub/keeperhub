import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  buildSimulationUnsupportedChainError,
  registerTools,
} from "@/lib/mcp/tools";
import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";

const SIMULATION_HINT =
  "Direct-execution simulation is EVM-only. Preflight with a Solana-aware client before broadcasting.";

type FetchMock = ReturnType<typeof vi.fn>;
type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 202,
      statusText: "Accepted",
      headers: { get: () => "application/json" },
      json: () =>
        Promise.resolve({ executionId: "exec_1", status: "completed" }),
      text: () => Promise.resolve(""),
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type ConnectedClient = { client: Client; close: () => Promise<void> };

async function connectedClient(): Promise<ConnectedClient> {
  const server = new McpServer({
    name: "simulation-error-test",
    version: "0.0.0",
  });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "simulation-error-test-client",
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

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const { client, close } = await connectedClient();
  try {
    return (await client.callTool({
      name,
      arguments: args,
    })) as ToolCallResult;
  } finally {
    await close();
  }
}

describe("buildSimulationUnsupportedChainError", () => {
  it("returns JSON aligned with the scope-denied envelope keys", () => {
    const error = buildSimulationUnsupportedChainError(
      SUPPORTED_CHAIN_IDS.SOLANA_MAINNET
    );
    const parsed = JSON.parse(error.message) as {
      error: string;
      message: string;
      chain_id: number;
      hint: string;
    };
    expect(parsed.error).toBe("simulation_unsupported_chain");
    expect(parsed.message).toBe(
      "Direct-execution simulation is not supported on this chain."
    );
    expect(parsed.chain_id).toBe(SUPPORTED_CHAIN_IDS.SOLANA_MAINNET);
    expect(parsed.hint).toBe(SIMULATION_HINT);
  });

  it("includes chain_id for Solana devnet", () => {
    const error = buildSimulationUnsupportedChainError(
      SUPPORTED_CHAIN_IDS.SOLANA_DEVNET
    );
    const parsed = JSON.parse(error.message) as { chain_id: number };
    expect(parsed.chain_id).toBe(SUPPORTED_CHAIN_IDS.SOLANA_DEVNET);
  });
});

describe("execute_transfer simulate on Solana surfaces structured error", () => {
  it("returns isError with simulation_unsupported_chain in content text", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: String(SUPPORTED_CHAIN_IDS.SOLANA_MAINNET),
      to_address: "So11111111111111111111111111111111111111112",
      amount: "0.1",
      simulate: true,
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const text = (result.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    const parsed = JSON.parse(text) as {
      error: string;
      message: string;
      chain_id: number;
      hint: string;
    };
    expect(parsed.error).toBe("simulation_unsupported_chain");
    expect(parsed.message).toBe(
      "Direct-execution simulation is not supported on this chain."
    );
    expect(parsed.chain_id).toBe(SUPPORTED_CHAIN_IDS.SOLANA_MAINNET);
    expect(parsed.hint).toBe(SIMULATION_HINT);
  });
});
