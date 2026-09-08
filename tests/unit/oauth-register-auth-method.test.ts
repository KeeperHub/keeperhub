/**
 * Dynamic Client Registration persists token_endpoint_auth_method so the token
 * endpoint can tell confidential clients (which must present a client_secret)
 * apart from public PKCE clients ("none"). A secret is only returned to
 * confidential registrations; public clients receive none.
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

type PersistedClient = { tokenEndpointAuthMethod: string };
type RegisterResponse = { client_secret?: string };

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

describe("POST /api/oauth/register -- token_endpoint_auth_method", () => {
  it("persists 'none' and returns no client_secret for public PKCE clients", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Public Client",
        redirect_uris: ["https://example.com/cb"],
        token_endpoint_auth_method: "none",
      })
    );
    expect(response.status).toBe(201);

    const persisted = (
      mockStoreOAuthClient.mock.calls[0] as unknown as [PersistedClient]
    )?.[0];
    expect(persisted?.tokenEndpointAuthMethod).toBe("none");

    const body = (await response.json()) as RegisterResponse;
    expect(body.client_secret).toBeUndefined();
  });

  it("defaults a missing auth method to 'none' and returns no client_secret", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Default Client",
        redirect_uris: ["https://example.com/cb"],
      })
    );
    expect(response.status).toBe(201);

    const persisted = (
      mockStoreOAuthClient.mock.calls[0] as unknown as [PersistedClient]
    )?.[0];
    expect(persisted?.tokenEndpointAuthMethod).toBe("none");

    const body = (await response.json()) as RegisterResponse;
    expect(body.client_secret).toBeUndefined();
  });

  it("persists the confidential method and returns a client_secret", async () => {
    const response = await POST(
      buildRequest({
        client_name: "Confidential Client",
        redirect_uris: ["https://example.com/cb"],
        token_endpoint_auth_method: "client_secret_post",
      })
    );
    expect(response.status).toBe(201);

    const persisted = (
      mockStoreOAuthClient.mock.calls[0] as unknown as [PersistedClient]
    )?.[0];
    expect(persisted?.tokenEndpointAuthMethod).toBe("client_secret_post");

    const body = (await response.json()) as RegisterResponse;
    expect(typeof body.client_secret).toBe("string");
  });
});
