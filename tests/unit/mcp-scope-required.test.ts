/**
 * KEEP-483: scope-denied errors must tell clients which scope to request
 * on reauthorize. Previously a write tool on a read-only token returned
 * generic "Forbidden" so builders had no actionable signal.
 *
 * Tests `getRequiredScopeForTool` (the new public helper) and asserts the
 * full set of tool -> required-scope mappings so the contract doesn't
 * silently drift as new tools are added.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  getRequiredScopeForTool,
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

describe("getRequiredScopeForTool (KEEP-483)", () => {
  it.each([
    "list_workflows",
    "get_workflow",
    "get_execution",
    "list_action_schemas",
    "search_plugins",
    "list_integrations",
    "list_projects",
    "list_tags",
  ])("returns mcp:read for read tool %s", (toolName) => {
    expect(getRequiredScopeForTool(toolName)).toBe(SCOPE_MCP_READ);
  });

  it.each([
    "create_workflow",
    "update_workflow",
    "delete_workflow",
    "execute_workflow",
    "deploy_template",
    "ai_generate_workflow",
    "execute_transfer",
    "execute_contract_call",
    "call_workflow",
    "list_workflow",
    "unlist_workflow",
    "create_project",
    "create_tag",
  ])("returns mcp:write for write tool %s", (toolName) => {
    expect(getRequiredScopeForTool(toolName)).toBe(SCOPE_MCP_WRITE);
  });

  it("returns mcp:admin for unknown tools (fail closed)", () => {
    expect(getRequiredScopeForTool("not_a_real_tool")).toBe(SCOPE_MCP_ADMIN);
    expect(getRequiredScopeForTool("")).toBe(SCOPE_MCP_ADMIN);
  });

  it("read scope is sufficient for every read tool — clients know to request it", () => {
    // Sanity check: every tool that lives in READ_TOOLS should map to
    // mcp:read, not mcp:write. If a read tool ever needed write, the
    // Hydra-style "I have read, why does this 401" confusion comes back.
    const readToolSample = [
      "list_workflows",
      "get_workflow",
      "get_execution",
      "search_workflows",
      "search_templates",
    ];
    for (const tool of readToolSample) {
      const required = getRequiredScopeForTool(tool);
      expect(required).not.toBe(SCOPE_MCP_WRITE);
      expect(required).not.toBe(SCOPE_MCP_ADMIN);
    }
  });
});

// ---------------------------------------------------------------------------
// Envelope-shape regression test (KEEP-483 review WARN)
// ---------------------------------------------------------------------------

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

type ScopeDeniedEnvelope = {
  error: string;
  message: string;
  required_scope: string;
  granted_scope: string;
  tool: string;
  upgrade_url?: string;
  hint: string;
};

describe("buildScopeDeniedResult envelope shape (KEEP-483)", () => {
  it("returns all six (+message+hint) keys with isError: true when scope is insufficient", async () => {
    // Drive the denial through the real registerTools path so we pin the
    // contract that agents actually observe over the wire — not the
    // private helper's shape directly.
    const { server, registeredTools } = makeMockServer();
    registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_READ);

    const createTool = registeredTools.find(
      (t) => t.name === "create_workflow"
    );
    expect(createTool).toBeDefined();
    if (!createTool) {
      return;
    }

    const result = (await createTool.handler({
      name: "x",
      nodes: [],
      edges: [],
    })) as {
      content: [{ type: "text"; text: string }];
      isError: true;
    };

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const envelope = JSON.parse(result.content[0].text) as ScopeDeniedEnvelope;

    // All six structured fields + the human-readable message + hint must
    // be present. If any of these go missing, agents lose the recovery
    // affordance the envelope was designed to provide.
    expect(envelope.error).toBe("insufficient_scope");
    expect(envelope.message).toContain(SCOPE_MCP_WRITE);
    expect(envelope.required_scope).toBe(SCOPE_MCP_WRITE);
    expect(envelope.granted_scope).toBe(SCOPE_MCP_READ);
    expect(envelope.tool).toBe("create_workflow");
    expect(envelope.hint).toContain(SCOPE_MCP_WRITE);

    // upgrade_url must point at the real stub page and carry the
    // granted/required pair so the page can render contextual messaging.
    expect(envelope.upgrade_url).toBe(
      `/settings/mcp/reauthorize?required=${encodeURIComponent(
        SCOPE_MCP_WRITE
      )}&granted=${encodeURIComponent(SCOPE_MCP_READ)}`
    );
  });

  it("encodes an empty granted scope correctly in upgrade_url", async () => {
    // An empty granted scope is the "no scopes at all" case. The URL
    // must still be well-formed (no `granted=undefined`, no broken
    // template) so the recovery page can render.
    const { server, registeredTools } = makeMockServer();
    registerTools(server, "http://internal", "Bearer test", "");

    const listTool = registeredTools.find((t) => t.name === "list_workflows");
    expect(listTool).toBeDefined();
    if (!listTool) {
      return;
    }

    const result = (await listTool.handler({})) as {
      content: [{ type: "text"; text: string }];
      isError: true;
    };
    const envelope = JSON.parse(result.content[0].text) as ScopeDeniedEnvelope;

    expect(envelope.granted_scope).toBe("");
    expect(envelope.upgrade_url).toBe(
      `/settings/mcp/reauthorize?required=${encodeURIComponent(
        SCOPE_MCP_READ
      )}&granted=`
    );
  });
});

describe("scope-denied remediation matches the credential family", () => {
  async function denyCreateWorkflow(
    credentialType?: "oauth" | "api-key"
  ): Promise<ScopeDeniedEnvelope> {
    const { server, registeredTools } = makeMockServer();
    registerTools(
      server,
      "http://internal",
      "Bearer test",
      SCOPE_MCP_READ,
      credentialType
    );
    const createTool = registeredTools.find(
      (t) => t.name === "create_workflow"
    );
    if (!createTool) {
      throw new Error("create_workflow was not registered");
    }
    const result = (await createTool.handler({
      name: "x",
      nodes: [],
      edges: [],
    })) as { content: [{ type: "text"; text: string }] };
    return JSON.parse(result.content[0].text) as ScopeDeniedEnvelope;
  }

  it("does not send an API key to the OAuth reauthorize page", async () => {
    const envelope = await denyCreateWorkflow("api-key");

    // There is no consent screen behind a kh_ key, so an upgrade_url is a
    // dead end: the agent re-runs the flow and is denied identically.
    expect(envelope.upgrade_url).toBeUndefined();
    expect(envelope.hint).toContain("A new key has to be issued");
    expect(envelope.hint).not.toContain("Reauthorize");
    expect(envelope.message).toContain("API key");
    expect(envelope.message).not.toContain("OAuth scope");
  });

  it("keeps the reauthorize route for an OAuth connection", async () => {
    const envelope = await denyCreateWorkflow("oauth");

    expect(envelope.upgrade_url).toContain("/settings/mcp/reauthorize");
    expect(envelope.hint).toContain("Reauthorize");
    expect(envelope.hint).not.toContain("A new key has to be issued");
  });

  it("falls back to the OAuth affordance when the family is unknown", async () => {
    const envelope = await denyCreateWorkflow();

    expect(envelope.upgrade_url).toContain("/settings/mcp/reauthorize");
    expect(envelope.required_scope).toBe(SCOPE_MCP_WRITE);
  });
});
