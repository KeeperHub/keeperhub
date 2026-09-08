import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

type ToolRegistration = {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: McpServer;
  registeredTools: ToolRegistration[];
} {
  const registeredTools: ToolRegistration[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        schema: Record<string, z.ZodTypeAny>,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, schema, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

async function findTool(name: string): Promise<ToolRegistration> {
  const { server, registeredTools } = makeMockServer();
  const { registerTools } = await import("@/lib/mcp/tools");
  registerTools(server, "http://localhost:3000", "Bearer test-token");
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return tool;
}

describe("MCP workflow tools accept enabled flag", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("update_workflow schema accepts an optional enabled boolean", async () => {
    const tool = await findTool("update_workflow");
    expect(tool.schema.enabled).toBeDefined();

    const enabledField = tool.schema.enabled;
    expect(enabledField.safeParse(true).success).toBe(true);
    expect(enabledField.safeParse(false).success).toBe(true);
    expect(enabledField.safeParse(undefined).success).toBe(true);
    expect(enabledField.safeParse("true").success).toBe(false);
  });

  it("create_workflow schema accepts an optional enabled boolean", async () => {
    const tool = await findTool("create_workflow");
    expect(tool.schema.enabled).toBeDefined();

    const enabledField = tool.schema.enabled;
    expect(enabledField.safeParse(true).success).toBe(true);
    expect(enabledField.safeParse(false).success).toBe(true);
    expect(enabledField.safeParse(undefined).success).toBe(true);
    expect(enabledField.safeParse(0).success).toBe(false);
  });

  it("update_workflow handler forwards enabled to the workflow PATCH endpoint", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ id: "wf-1", enabled: true }),
          text: async () => "",
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = await findTool("update_workflow");
    await tool.handler({ workflowId: "wf-1", enabled: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/workflows/wf-1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
  });

  it("create_workflow handler forwards enabled to the workflow create endpoint", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ id: "wf-2", enabled: true }),
          text: async () => "",
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = await findTool("create_workflow");
    await tool.handler({
      name: "Test",
      nodes: [],
      edges: [],
      enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/workflows/create");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
  });
});
