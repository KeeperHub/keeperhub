/**
 * KEEP-483 (root cause): Dynamic Client Registration must default to
 * `mcp:read mcp:write` when the client omits `scope`.
 *
 * Standard MCP DCR clients (Anthropic reference, Hydra, etc.) do not pass
 * a `scope` field on registration. Before this fix, the route fell back to
 * `mcp:read` only, so those clients were permanently registered read-only
 * and silently 401'd on every write tool. The recovery path
 * (`upgrade_url` envelope + reauthorize stub) shipped on the previous
 * commit handles already-registered clients; this regression test pins
 * the default for newly-registered clients.
 *
 * Also asserts the explicit-restriction path still works: a client that
 * deliberately requests `scope: "mcp:read"` for least-privilege must
 * still end up with read-only access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockStoreOAuthClient } = vi.hoisted(() => ({
  mockStoreOAuthClient: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  storeOAuthClient: mockStoreOAuthClient,
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => "127.0.0.1",
}));

import { POST } from "@/app/api/oauth/register/route";
import { parseScopes } from "@/lib/mcp/oauth-scopes";

type RegisteredClient = {
  scopes: string[];
};

type RegisterResponse = {
  client_id: string;
  scope: string;
};

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockStoreOAuthClient.mockClear();
});

describe("POST /api/oauth/register -- default scope (KEEP-483)", () => {
  it("defaults to `mcp:read mcp:write` when the client omits the scope field", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Anthropic Reference MCP Client",
        redirect_uris: ["https://example.com/callback"],
      })
    );

    expect(response.status).toBe(201);

    const persisted = (
      mockStoreOAuthClient.mock.calls[0] as unknown as [RegisteredClient]
    )?.[0];
    expect(persisted).toBeDefined();
    expect(persisted?.scopes).toEqual(["mcp:read", "mcp:write"]);

    const body = (await response.json()) as RegisterResponse;
    const returned = parseScopes(body.scope);
    expect(returned).toContain("mcp:read");
    expect(returned).toContain("mcp:write");
  });

  it("respects an explicit `mcp:read` scope request (least-privilege path still works)", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Read-Only Client",
        redirect_uris: ["https://example.com/callback"],
        scope: "mcp:read",
      })
    );

    expect(response.status).toBe(201);

    const persisted = (
      mockStoreOAuthClient.mock.calls[0] as unknown as [RegisteredClient]
    )?.[0];
    expect(persisted).toBeDefined();
    expect(persisted?.scopes).toEqual(["mcp:read"]);

    const body = (await response.json()) as RegisterResponse;
    expect(parseScopes(body.scope)).toEqual(["mcp:read"]);
  });
});
