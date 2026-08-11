import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

// The execute tools live in WRITE_TOOLS, but isToolAllowed matches on tool
// name alone. A dry run is read-only, so an mcp:read token must be able to
// call them with simulate: true.

type RegisteredTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

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
        _schema: unknown,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

const EXECUTE_TOOLS = [
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
] as const;

function handlerFor(name: string): (...args: unknown[]) => unknown {
  const { server, registeredTools } = makeMockServer();
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_READ);
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return tool.handler;
}

function parseResult(result: unknown): Record<string, unknown> {
  const envelope = result as { content: [{ text: string }] };
  return JSON.parse(envelope.content[0].text) as Record<string, unknown>;
}

const BASE_ARGS = {
  chain_id: "84532",
  to_address: "0xcc0000000000000000000000000000000000cc00",
  amount: "1.0",
  contract_address: "0xdd0000000000000000000000000000000000dd00",
  function_name: "transfer",
  abi: "[]",
  condition: { type: "always" },
  action: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ status: "simulated", wouldRevert: false }),
    })
  );
});

describe("MCP execute tools under an mcp:read token", () => {
  it.each(EXECUTE_TOOLS)("%s admits simulate: true", async (name) => {
    const result = await handlerFor(name)({ ...BASE_ARGS, simulate: true });
    expect(parseResult(result).error).not.toBe("insufficient_scope");
  });

  it.each(EXECUTE_TOOLS)("%s denies a broadcast", async (name) => {
    const result = await handlerFor(name)(BASE_ARGS);
    const body = parseResult(result);
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:write");
  });

  // A truthy non-boolean must not downgrade the requirement.
  it.each(EXECUTE_TOOLS)("%s denies a string simulate", async (name) => {
    const result = await handlerFor(name)({ ...BASE_ARGS, simulate: "true" });
    expect(parseResult(result).error).toBe("insufficient_scope");
  });
});
