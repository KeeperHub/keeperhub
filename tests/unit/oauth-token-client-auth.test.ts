/**
 * Confidential MCP OAuth clients (token_endpoint_auth_method other than
 * "none") must present a valid client_secret on both the authorization_code
 * and refresh_token grants. Before this change the token endpoint loaded the
 * client but never verified clientSecretHash, so the column was dead code and
 * a leaked refresh token alone was sufficient. Public PKCE clients ("none")
 * continue to authenticate by client_id + PKCE only.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockGetOAuthClient,
  mockGetRefreshToken,
  mockDeleteRefreshToken,
  mockStoreRefreshToken,
  mockGetAuthCode,
  mockDeleteAuthCode,
} = vi.hoisted(() => ({
  mockGetOAuthClient: vi.fn(),
  mockGetRefreshToken: vi.fn(),
  mockDeleteRefreshToken: vi.fn(async () => undefined),
  mockStoreRefreshToken: vi.fn(async () => undefined),
  mockGetAuthCode: vi.fn(),
  mockDeleteAuthCode: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  getOAuthClient: mockGetOAuthClient,
  getRefreshToken: mockGetRefreshToken,
  deleteRefreshToken: mockDeleteRefreshToken,
  storeRefreshToken: mockStoreRefreshToken,
  getAuthCode: mockGetAuthCode,
  deleteAuthCode: mockDeleteAuthCode,
  REFRESH_TOKEN_TTL_MS: 1000,
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  createAccessToken: vi.fn(async () => "access-token-stub"),
}));

vi.mock("@/lib/auth-deactivation-guard", () => ({
  isUserDeactivated: vi.fn(async () => false),
}));

vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: vi.fn(async () => true),
}));

import { POST } from "@/app/api/oauth/token/route";

const SECRET = "super-secret-value";
const SECRET_HASH = createHash("sha256").update(SECRET).digest("hex");

function client(method: string) {
  return {
    clientId: "client-1",
    clientSecretHash: SECRET_HASH,
    tokenEndpointAuthMethod: method,
    clientName: "Test",
    redirectUris: ["https://example.com/cb"],
    scopes: ["mcp:read", "mcp:write"],
    grantTypes: ["authorization_code", "refresh_token"],
    organizationId: null,
    createdAt: Date.now(),
  };
}

function refreshRequest(body: Record<string, string>): Request {
  return new Request("http://localhost/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

beforeEach(() => {
  for (const m of [
    mockGetOAuthClient,
    mockGetRefreshToken,
    mockDeleteRefreshToken,
    mockStoreRefreshToken,
    mockGetAuthCode,
    mockDeleteAuthCode,
  ]) {
    m.mockReset();
  }
  mockDeleteRefreshToken.mockResolvedValue(undefined);
  mockStoreRefreshToken.mockResolvedValue(undefined);
  mockDeleteAuthCode.mockResolvedValue(undefined);
});

describe("token endpoint -- confidential client authentication", () => {
  it("rejects refresh when a confidential client omits client_secret", async () => {
    mockGetOAuthClient.mockResolvedValue(client("client_secret_post"));
    const res = await POST(
      refreshRequest({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "client-1",
      })
    );
    expect(res.status).toBe(401);
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      error: string;
      detail: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toBe(body.detail);
  });

  it("rejects refresh when the client_secret is wrong", async () => {
    mockGetOAuthClient.mockResolvedValue(client("client_secret_post"));
    const res = await POST(
      refreshRequest({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "client-1",
        client_secret: "wrong",
      })
    );
    expect(res.status).toBe(401);
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("accepts refresh with the correct client_secret", async () => {
    mockGetOAuthClient.mockResolvedValue(client("client_secret_post"));
    mockGetRefreshToken.mockResolvedValue({
      token: "rt-1",
      clientId: "client-1",
      userId: "user-1",
      organizationId: "org-1",
      scope: "mcp:read",
      expiresAt: Date.now() + 100_000,
    });
    const res = await POST(
      refreshRequest({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "client-1",
        client_secret: SECRET,
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetRefreshToken).toHaveBeenCalled();
  });

  it("accepts refresh from a public PKCE client with no secret", async () => {
    mockGetOAuthClient.mockResolvedValue(client("none"));
    mockGetRefreshToken.mockResolvedValue({
      token: "rt-1",
      clientId: "client-1",
      userId: "user-1",
      organizationId: "org-1",
      scope: "mcp:read",
      expiresAt: Date.now() + 100_000,
    });
    const res = await POST(
      refreshRequest({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "client-1",
      })
    );
    expect(res.status).toBe(200);
  });

  it("accepts the client_secret via HTTP Basic auth", async () => {
    mockGetOAuthClient.mockResolvedValue(client("client_secret_basic"));
    mockGetRefreshToken.mockResolvedValue({
      token: "rt-1",
      clientId: "client-1",
      userId: "user-1",
      organizationId: "org-1",
      scope: "mcp:read",
      expiresAt: Date.now() + 100_000,
    });
    const basic = Buffer.from(`client-1:${SECRET}`).toString("base64");
    const res = await POST(
      new Request("http://localhost/api/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt-1",
          client_id: "client-1",
        }).toString(),
      })
    );
    expect(res.status).toBe(200);
  });

  it("accepts authorization_code exchange from a public PKCE client with no secret", async () => {
    const verifier = "pkce-verifier-value";
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    mockGetOAuthClient.mockResolvedValue(client("none"));
    mockGetAuthCode.mockResolvedValue({
      code: "code-1",
      clientId: "client-1",
      redirectUri: "https://example.com/cb",
      scope: "mcp:read",
      userId: "user-1",
      organizationId: "org-1",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + 100_000,
    });
    const res = await POST(
      refreshRequest({
        grant_type: "authorization_code",
        code: "code-1",
        client_id: "client-1",
        redirect_uri: "https://example.com/cb",
        code_verifier: verifier,
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetAuthCode).toHaveBeenCalled();
  });

  it("rejects authorization_code exchange when a confidential client omits client_secret", async () => {
    mockGetOAuthClient.mockResolvedValue(client("client_secret_post"));
    const res = await POST(
      refreshRequest({
        grant_type: "authorization_code",
        code: "code-1",
        client_id: "client-1",
        redirect_uri: "https://example.com/cb",
        code_verifier: "verifier",
      })
    );
    expect(res.status).toBe(401);
    expect(mockGetAuthCode).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });
});
