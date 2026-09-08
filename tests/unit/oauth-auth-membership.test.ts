import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockIsMember } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockIsMember: vi.fn(),
}));

// The auth path reads the scope epoch and records liveness; neither is what
// these tests exercise, so both are stubbed to their no-change answers.
vi.mock("@/lib/mcp/scope-policy", () => ({
  DEFAULT_EPOCH: 0,
  effectiveScope: (scope: string) => scope,
  getScopePolicy: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
  getScopePolicyForMint: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
}));

vi.mock("@/lib/mcp/connections", () => ({
  touchConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

import {
  authenticateOAuthToken,
  createAccessToken,
} from "@/lib/mcp/oauth-auth";

function buildRequestWithToken(token: string): Request {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the token subject is an active (non-deactivated) user so the
  // membership re-check is the only gate under test.
  mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
});

describe("authenticateOAuthToken -- org membership re-check", () => {
  it("rejects a token whose subject is no longer a member of the org", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockIsMember.mockResolvedValue(false);

    const result = await authenticateOAuthToken(buildRequestWithToken(token));

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe(
      "User is no longer a member of this organization"
    );
    expect(mockIsMember).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("authenticates a token whose subject is a current member", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockIsMember.mockResolvedValue(true);

    const result = await authenticateOAuthToken(buildRequestWithToken(token));

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user-1");
    expect(result.organizationId).toBe("org-1");
    expect(result.scope).toBe("read");
  });
});
