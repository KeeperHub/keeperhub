import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockAuthenticateOAuthToken, mockAuthenticateApiKey } = vi.hoisted(
  () => ({
    mockAuthenticateOAuthToken: vi.fn(),
    mockAuthenticateApiKey: vi.fn(),
  })
);

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: mockAuthenticateOAuthToken,
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

import { validateApiKey } from "@/app/api/execute/_lib/auth";

function request(): Request {
  return new Request("http://localhost/api/execute/node", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateApiKey -- anonymous and failure propagation", () => {
  it("surfaces a 403 when the OAuth subject is forbidden (anonymous)", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      error: "Anonymous accounts cannot use API access tokens",
      statusCode: 403,
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({
      error: "Anonymous accounts cannot use API access tokens",
      status: 403,
    });
    // A forbidden subject must not fall through to api-key auth.
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it("surfaces a 403 when the API-key creator is forbidden (anonymous)", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: false,
      error: "Anonymous accounts cannot use API keys",
      statusCode: 403,
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({
      error: "Anonymous accounts cannot use API keys",
      status: 403,
    });
  });

  it("returns a 401 when neither credential authenticates", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({ error: "Unauthorized", status: 401 });
  });

  it("returns the org context for a valid OAuth token", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: true,
      userId: "user-1",
      organizationId: "org-1",
      scope: "mcp:write",
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({
      organizationId: "org-1",
      apiKeyId: "oauth:user-1",
      scope: "mcp:write",
      credentialType: "oauth",
    });
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it("returns the org context for a valid API key", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "org-2",
      apiKeyId: "key-1",
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({
      organizationId: "org-2",
      apiKeyId: "key-1",
      credentialType: "api-key",
    });
  });

  it("propagates the scope an API key was minted with", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "org-2",
      apiKeyId: "key-1",
      userId: "user-2",
      scope: "mcp:read",
    });

    const result = await validateApiKey(request());

    expect(result).toEqual({
      organizationId: "org-2",
      apiKeyId: "key-1",
      scope: "mcp:read",
      credentialType: "api-key",
    });
  });

  it("leaves scope undefined for a key whose scope column is NULL", async () => {
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: false,
      statusCode: 401,
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "org-2",
      apiKeyId: "key-1",
      scope: undefined,
    });

    const result = await validateApiKey(request());

    expect(result).not.toHaveProperty("error");
    expect((result as { scope?: string }).scope).toBeUndefined();
  });
});
