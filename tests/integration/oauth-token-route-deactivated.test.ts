import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockUsersFindFirst,
  mockGetAuthCode,
  mockDeleteAuthCode,
  mockGetOAuthClient,
  mockGetRefreshToken,
  mockDeleteRefreshToken,
  mockStoreRefreshToken,
  mockCreateAccessToken,
  mockIsMember,
} = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockGetAuthCode: vi.fn(),
  mockDeleteAuthCode: vi.fn(),
  mockGetOAuthClient: vi.fn(),
  mockGetRefreshToken: vi.fn(),
  mockDeleteRefreshToken: vi.fn(),
  mockStoreRefreshToken: vi.fn(),
  mockCreateAccessToken: vi.fn(),
  mockIsMember: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  createAccessToken: mockCreateAccessToken,
}));

vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  deleteAuthCode: mockDeleteAuthCode,
  deleteRefreshToken: mockDeleteRefreshToken,
  getAuthCode: mockGetAuthCode,
  getOAuthClient: mockGetOAuthClient,
  getRefreshToken: mockGetRefreshToken,
  REFRESH_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  storeRefreshToken: mockStoreRefreshToken,
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  // Defeat the IP rate limiter so the test never flakes on it; it has its
  // own coverage elsewhere.
  checkIpRateLimit: () => ({ allowed: true, retryAfter: 0 }),
  getClientIp: () => "127.0.0.1",
}));

import { POST } from "@/app/api/oauth/token/route";

const PKCE_VERIFIER = "test-verifier-which-is-long-enough-for-pkce";
// Pre-computed S256 challenge for the verifier above so the route's PKCE
// check passes when we exchange the authorization code in tests.
const PKCE_CHALLENGE_S256 = "PsIsgqMzZT5khvUgUwae5DKM9JG6k-rZMs42eJW1bbM";
const TEST_REDIRECT_URI = "https://example.com/callback";
const TEST_CLIENT_ID = "client-1";
const TEST_USER_ID = "user-1";
const TEST_ORG_ID = "org-1";

async function postForm(body: Record<string, string>): Promise<Response> {
  return await POST(
    new Request("http://localhost/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    })
  );
}

type EnvelopeBody = {
  error: string;
  detail: string;
  error_description?: string;
  request_id?: string;
};

function stubActiveOAuthClient(): void {
  mockGetOAuthClient.mockResolvedValue({
    clientId: TEST_CLIENT_ID,
    redirectUris: [TEST_REDIRECT_URI],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateAccessToken.mockResolvedValue("access-token-stub");
  // Default to a current member so deactivation-focused cases are unaffected;
  // membership-focused cases override this explicitly.
  mockIsMember.mockResolvedValue(true);
});

describe("POST /api/oauth/token -- authorization_code grant", () => {
  it("issues tokens for an active user", async () => {
    stubActiveOAuthClient();
    mockGetAuthCode.mockResolvedValue({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
      codeChallenge: PKCE_CHALLENGE_S256,
      codeChallengeMethod: "S256",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const response = await postForm({
      grant_type: "authorization_code",
      code: "auth-code-1",
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token?: string };
    expect(body.access_token).toBe("access-token-stub");
    expect(mockStoreRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("rejects authorization_code exchange for a deactivated user", async () => {
    // Reproduces the gap between auth-code consent and code exchange: the
    // user is deactivated after consenting, an attacker holding the code
    // tries to redeem it. Must fail before any token is minted or stored.
    stubActiveOAuthClient();
    mockGetAuthCode.mockResolvedValue({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
      codeChallenge: PKCE_CHALLENGE_S256,
      codeChallengeMethod: "S256",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-05-21T08:41:16Z"),
    });

    const response = await postForm({
      grant_type: "authorization_code",
      code: "auth-code-1",
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_grant");
    expect(body.detail).toBe("User account is deactivated");
    expect(body.error_description).toBe(body.detail);
    expect(mockCreateAccessToken).not.toHaveBeenCalled();
    expect(mockStoreRefreshToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/oauth/token -- refresh_token grant", () => {
  it("rotates tokens for an active user", async () => {
    stubActiveOAuthClient();
    mockGetRefreshToken.mockResolvedValue({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      clientId: TEST_CLIENT_ID,
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
    mockIsMember.mockResolvedValue(true);

    const response = await postForm({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: TEST_CLIENT_ID,
    });

    expect(response.status).toBe(200);
    expect(mockDeleteRefreshToken).toHaveBeenCalledWith("refresh-1");
    expect(mockStoreRefreshToken).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessToken).toHaveBeenCalledTimes(1);
  });

  it("rejects refresh_token exchange when no longer an org member", async () => {
    // The user was removed from (or left) the org after the refresh token was
    // issued. The presented token is still rotated out, but no fresh
    // org-scoped credential is minted in its place.
    stubActiveOAuthClient();
    mockGetRefreshToken.mockResolvedValue({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      clientId: TEST_CLIENT_ID,
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
    mockIsMember.mockResolvedValue(false);

    const response = await postForm({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: TEST_CLIENT_ID,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_grant");
    expect(body.detail).toBe("User is no longer a member of this organization");
    expect(body.error_description).toBe(body.detail);
    expect(mockIsMember).toHaveBeenCalledWith(TEST_USER_ID, TEST_ORG_ID);
    expect(mockDeleteRefreshToken).toHaveBeenCalledWith("refresh-1");
    expect(mockStoreRefreshToken).not.toHaveBeenCalled();
    expect(mockCreateAccessToken).not.toHaveBeenCalled();
  });

  it("rejects refresh_token exchange for a deactivated user", async () => {
    // The Barbara-shape: attacker holds a refresh token issued before
    // deactivation, tries to swap it for a fresh access + refresh pair.
    // Must fail before storing a new refresh token (otherwise the
    // attacker could indefinitely cycle the credential).
    stubActiveOAuthClient();
    mockGetRefreshToken.mockResolvedValue({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      clientId: TEST_CLIENT_ID,
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-05-21T08:41:16Z"),
    });

    const response = await postForm({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: TEST_CLIENT_ID,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_grant");
    expect(body.detail).toBe("User account is deactivated");
    expect(body.error_description).toBe(body.detail);
    // The presented refresh token must still be invalidated -- attacker
    // does not get to keep replaying the same token after a deactivated
    // attempt.
    expect(mockDeleteRefreshToken).toHaveBeenCalledWith("refresh-1");
    expect(mockStoreRefreshToken).not.toHaveBeenCalled();
    expect(mockCreateAccessToken).not.toHaveBeenCalled();
  });
});
