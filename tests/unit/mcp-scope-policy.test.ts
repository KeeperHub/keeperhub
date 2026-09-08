import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockIsMember, mockGetPolicy, mockTouch } =
  vi.hoisted(() => ({
    mockGetPolicy: vi.fn(),
    mockIsMember: vi.fn(),
    mockTouch: vi.fn(),
    mockUsersFindFirst: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));
vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));
vi.mock("@/lib/mcp/connections", () => ({ touchConnection: mockTouch }));

// The real clamp is used, so the guard is tested rather than mocked away.
vi.mock("@/lib/mcp/scope-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp/scope-policy")>();
  return {
    ...actual,
    getScopePolicy: mockGetPolicy,
    getScopePolicyForMint: mockGetPolicy,
  };
});

process.env.OAUTH_JWT_SECRET = "test-secret-32-bytes-long-enough-for-hs256";

import {
  authenticateOAuthToken,
  createAccessToken,
} from "@/lib/mcp/oauth-auth";

function policy(
  epoch: number,
  orgMaxScope: string | null = null,
  memberMaxScope: string | null = null
): {
  epoch: number;
  orgMaxScope: string | null;
  memberMaxScope: string | null;
} {
  return { epoch, memberMaxScope, orgMaxScope };
}

function request(token: string): Request {
  return new Request("http://localhost/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function mint(epoch: number, scope = "mcp:write"): Promise<string> {
  mockGetPolicy.mockResolvedValue(policy(epoch));
  return await createAccessToken({ org: "org_1", scope, sub: "user_1" });
}

describe("MCP access is bounded by the organization's policy, not the token", () => {
  beforeEach(() => {
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: null,
      email: "person@example.com",
      isAnonymous: false,
      name: "Person",
    });
    mockIsMember.mockResolvedValue(true);
    mockTouch.mockResolvedValue(undefined);
  });

  it("accepts a token minted at the current epoch", async () => {
    const token = await mint(3);
    mockGetPolicy.mockResolvedValue(policy(3));

    const result = await authenticateOAuthToken(request(token));

    expect(result.authenticated).toBe(true);
    expect(result.scope).toBe("mcp:write");
  });

  it("rejects a token minted before a revoke or scope change", async () => {
    const token = await mint(3);
    mockGetPolicy.mockResolvedValue(policy(4));

    const result = await authenticateOAuthToken(request(token));

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("keeps accepting tokens minted before epochs existed", async () => {
    const token = await mint(0);
    mockGetPolicy.mockResolvedValue(policy(0));

    const result = await authenticateOAuthToken(request(token));

    expect(result.authenticated).toBe(true);
  });

  it("narrows a token to the member ceiling an admin set", async () => {
    // The person consented to write for themselves; the organization capped
    // them at read. The cap wins, without the token being reissued.
    const token = await mint(1, "mcp:read mcp:write");
    mockGetPolicy.mockResolvedValue(policy(1, null, "mcp:read"));

    const result = await authenticateOAuthToken(request(token));

    expect(result.authenticated).toBe(true);
    expect(result.scope).toBe("mcp:read");
  });

  it("narrows a token to the organization ceiling", async () => {
    const token = await mint(1, "mcp:admin");
    mockGetPolicy.mockResolvedValue(policy(1, "mcp:write", null));

    const result = await authenticateOAuthToken(request(token));

    expect(result.scope).toBe("mcp:write");
  });

  it("takes the lower ceiling when both are set", async () => {
    const token = await mint(1, "mcp:admin");
    mockGetPolicy.mockResolvedValue(policy(1, "mcp:write", "mcp:read"));

    const result = await authenticateOAuthToken(request(token));

    expect(result.scope).toBe("mcp:read");
  });

  it("never widens a token beyond what it was granted", async () => {
    // A ceiling is a maximum, not a grant: a read-only token stays read-only
    // under a full-access ceiling.
    const token = await mint(1, "mcp:read");
    mockGetPolicy.mockResolvedValue(policy(1, "mcp:admin", "mcp:admin"));

    const result = await authenticateOAuthToken(request(token));

    expect(result.scope).toBe("mcp:read");
  });

  it("does not record liveness for a token it rejects", async () => {
    const token = await mint(1);
    mockGetPolicy.mockResolvedValue(policy(2));
    mockTouch.mockClear();

    await authenticateOAuthToken(request(token));

    expect(mockTouch).not.toHaveBeenCalled();
  });
});
