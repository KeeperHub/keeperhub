import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("validate_cron MCP tool handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns valid for a well-formed cron expression", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const tool = tools.find((t) => t.name === "validate_cron");
    if (!tool) {
      throw new Error("validate_cron not registered");
    }

    const result = (await tool.handler({
      cronExpression: "0 9 * * *",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      description?: string;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.description).toBeTruthy();
  });

  it("returns invalid for malformed cron", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const tool = tools.find((t) => t.name === "validate_cron");
    if (!tool) {
      throw new Error("validate_cron not registered");
    }

    const result = (await tool.handler({
      cronExpression: "not-a-cron",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      error?: string;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it("rejects sub-60 scheduleIntervalSeconds", async () => {
    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const tool = tools.find((t) => t.name === "validate_cron");
    if (!tool) {
      throw new Error("validate_cron not registered");
    }

    const result = (await tool.handler({
      cronExpression: "0 9 * * *",
      scheduleIntervalSeconds: 30,
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text) as {
      valid: boolean;
      error?: string;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toContain("60");
    expect(parsed).not.toHaveProperty("description");
  });
});

type CapturedTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        tools.push({ name, handler });
      }
    ),
  };
  return { server, tools };
}
