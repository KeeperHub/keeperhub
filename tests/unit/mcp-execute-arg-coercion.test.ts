/**
 * #1841: the natural first guess - a number where a decimal string is wanted,
 * an array where its JSON encoding is wanted - is accepted and normalised
 * before the handler, so the REST body is byte-identical to the hand-encoded
 * call and the published schema still says `string`. A guess that cannot
 * round-trip losslessly (an integer past 2^53, anything that stringifies in
 * exponential notation) keeps its rejection rather than being corrupted, which
 * is what the second half of these tests pins.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type FetchMock = ReturnType<typeof vi.fn>;
type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

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

function errorText(result: ToolCallResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
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

type ConnectedClient = { client: Client; close: () => Promise<void> };

async function connectedClient(): Promise<ConnectedClient> {
  const server = new McpServer({ name: "coercion-test", version: "0.0.0" });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "coercion-test-client", version: "0.0.0" });

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

describe("MCP execute tools accept the natural first-guess encoding (#1841)", () => {
  it("execute_transfer takes a numeric chain_id and amount, and forwards strings", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: 11_155_111,
      to_address: "0xabc",
      amount: 0.1,
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("11155111");
    expect(body.amount).toBe("0.1");
  });

  it("execute_contract_call takes a real array for function_args and forwards its JSON encoding", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "transfer",
      function_args: ["0xdef", "1000"],
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("11155111");
    expect(body.functionArgs).toBe('["0xdef","1000"]');
  });

  it("execute_contract_call takes numeric gas_limit_multiplier, value and priority_fee_gwei", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "11155111",
      function_name: "deposit",
      gas_limit_multiplier: 1.5,
      value: 0.25,
      priority_fee_gwei: 2,
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.gasLimitMultiplier).toBe("1.5");
    expect(body.value).toBe("0.25");
    expect(body.priorityFeeGwei).toBe("2");
  });

  it("execute_contract_call takes an ABI array and forwards its JSON encoding", async () => {
    const abi = [{ name: "transfer", type: "function", inputs: [] }];
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "1",
      function_name: "transfer",
      abi,
    });

    expect(result.isError).toBeFalsy();
    expect(lastBody().abi).toBe(JSON.stringify(abi));
  });

  it("execute_check_and_execute coerces the nested condition value and action fields", async () => {
    const result = await callTool("execute_check_and_execute", {
      contract_address: "0xc",
      chain_id: 42_161,
      function_name: "balanceOf",
      function_args: ["0xholder"],
      condition: { operator: "gt", value: 1000 },
      action: {
        contract_address: "0xa",
        function_name: "withdraw",
        function_args: [],
        gas_limit_multiplier: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("42161");
    expect(body.functionArgs).toBe('["0xholder"]');
    expect((body.condition as { value: unknown }).value).toBe("1000");
    const action = body.action as Record<string, unknown>;
    expect(action.functionArgs).toBe("[]");
    expect(action.gasLimitMultiplier).toBe("2");
  });

  it("the hand-encoded call is unchanged - same body as the coerced one", async () => {
    await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "11155111",
      function_name: "transfer",
      function_args: '["0xdef","1000"]',
      gas_limit_multiplier: "1.5",
    });
    const encodedByHand = lastBody();

    await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "transfer",
      function_args: ["0xdef", "1000"],
      gas_limit_multiplier: 1.5,
    });

    expect(lastBody()).toEqual(encodedByHand);
  });

  it("still rejects an argument that is neither the string nor its natural guess", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: true,
      to_address: "0xabc",
      amount: "0.1",
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes string types - the coercion is a fallback, not a second encoding", async () => {
    const { client, close } = await connectedClient();
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "execute_contract_call");
      if (!tool) {
        throw new Error("execute_contract_call is not exposed");
      }
      const { properties } = tool.inputSchema as {
        properties: Record<string, { type?: string }>;
      };

      for (const field of [
        "chain_id",
        "function_args",
        "abi",
        "value",
        "gas_limit_multiplier",
        "priority_fee_gwei",
      ]) {
        expect(properties[field]?.type).toBe("string");
      }
    } finally {
      await close();
    }
  });

  /**
   * A bare `preprocess` accepts `unknown`, so schema generation reads the field
   * as omittable and silently drops it from `required` - `chain_id` and
   * `amount` stopped being advertised as required, with no runtime symptom to
   * notice. `.nonoptional()` in the helpers is what holds this; checking
   * `properties[...].type` alone does not catch it.
   */
  it.each([
    ["execute_transfer", ["chain_id", "to_address", "amount"]],
    [
      "execute_contract_call",
      ["contract_address", "chain_id", "function_name"],
    ],
    [
      "execute_check_and_execute",
      ["contract_address", "chain_id", "function_name", "condition", "action"],
    ],
  ])("keeps every %s field in the published required list", async (toolName, required) => {
    const { client, close } = await connectedClient();
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === toolName);
      if (!tool) {
        throw new Error(`${toolName} is not exposed`);
      }
      const schema = tool.inputSchema as { required?: string[] };
      expect(schema.required).toEqual(required);
    } finally {
      await close();
    }
  });

  it("keeps the nested condition value required", async () => {
    const { client, close } = await connectedClient();
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find(
        (t) => t.name === "execute_check_and_execute"
      );
      if (!tool) {
        throw new Error("execute_check_and_execute is not exposed");
      }
      const { properties } = tool.inputSchema as {
        properties: Record<string, { required?: string[] }>;
      };

      expect(properties.condition?.required).toEqual(["operator", "value"]);
    } finally {
      await close();
    }
  });

  it("publishes string types for the nested check_and_execute fields too", async () => {
    const { client, close } = await connectedClient();
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find(
        (t) => t.name === "execute_check_and_execute"
      );
      if (!tool) {
        throw new Error("execute_check_and_execute is not exposed");
      }
      const { properties } = tool.inputSchema as {
        properties: Record<
          string,
          { type?: string; properties?: Record<string, { type?: string }> }
        >;
      };

      expect(properties.condition?.properties?.value?.type).toBe("string");
      for (const field of ["function_args", "abi", "gas_limit_multiplier"]) {
        expect(properties.action?.properties?.[field]?.type).toBe("string");
      }
    } finally {
      await close();
    }
  });
});

/**
 * `String()` is only a safe encoder inside the range where it round-trips. Past
 * 2^53 it drops the low digits, and outside a narrow band it switches to
 * exponential notation, which no downstream parser recovers: `BigInt("1e+21")`
 * throws and `evaluateCondition` then falls through to a string `eq`/`neq`, so
 * a `gt` threshold silently never fires. Taking the guess in those ranges would
 * turn a clean rejection into a wrong amount on-chain, so the rejection stays.
 */
describe("the coercion refuses guesses it cannot encode losslessly", () => {
  // Written as a string on purpose: as a literal it would lose precision at
  // parse time, which is the very thing under test. This is what the client's
  // own JSON.parse hands the transport - already rounded to ...800.
  const UNSAFE_INTEGER = Number("1234567890123456789");
  const ABOVE_1E21 = 1e21;

  it.each([
    ["an integer past 2^53", UNSAFE_INTEGER],
    ["a value that stringifies in exponential notation", ABOVE_1E21],
    ["a small value that stringifies in exponential notation", 0.000_000_1],
  ])("rejects %s as a transfer amount", async (_label, amount) => {
    const result = await callTool("execute_transfer", {
      chain_id: 11_155_111,
      to_address: "0xabc",
      amount,
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("pass this value as a string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe integer inside function_args rather than encoding a wrong amount", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "transfer",
      function_args: ["0xdef", UNSAFE_INTEGER],
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("cannot be encoded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("walks nested ABI arguments - tuples and arrays of structs, not just the top level", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "multicall",
      function_args: [[{ to: "0xdef", amount: UNSAFE_INTEGER }]],
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a condition value at or above 1e21, which BigInt cannot parse", async () => {
    const result = await callTool("execute_check_and_execute", {
      contract_address: "0xc",
      chain_id: 42_161,
      function_name: "balanceOf",
      condition: { operator: "gt", value: ABOVE_1E21 },
      action: { contract_address: "0xa", function_name: "withdraw" },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects NaN and Infinity, which are not values at all", async () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY]) {
      fetchMock.mockClear();
      const result = await callTool("execute_transfer", {
        chain_id: 1,
        to_address: "0xabc",
        amount,
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects null for a JSON-string field - it is not an encodable object", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "1",
      function_name: "transfer",
      function_args: null,
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still takes the guess at the edge of the safe range", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: 11_155_111,
      to_address: "0xabc",
      amount: Number.MAX_SAFE_INTEGER,
    });

    expect(result.isError).toBeFalsy();
    expect(lastBody().amount).toBe("9007199254740991");
  });
});
