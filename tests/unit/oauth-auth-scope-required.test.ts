import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockIsMember } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockIsMember: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

// The auth path reads the scope epoch and records liveness. Neither is what
// this test is about, so both are stubbed to their no-change answers.
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

async function signRaw(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Subject is an active member so the scope claim is the only gate under test.
  mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
  mockIsMember.mockResolvedValue(true);
});

// A-03 linchpin. The REST scope guards (requireScope at every /api mutation
// sink) treat scope=undefined as full access for api-key/session callers. That
// is only safe because an authenticated OAuth token ALWAYS carries a string
// scope, guaranteed solely by isOAuthTokenPayload rejecting a scope-less
// payload. If that check is ever relaxed, ctx.scope would be undefined at the
// REST sinks and an mcp:read (or scope-less) token would regain write access
// across every gated route at once. These tests pin the invariant.
describe("authenticateOAuthToken -- scope claim is mandatory (A-03 linchpin)", () => {
  it("rejects a validly-signed token whose scope claim is omitted", async () => {
    const token = await signRaw({ sub: "user-1", org: "org-1" });

    const result = await authenticateOAuthToken(buildRequestWithToken(token));

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects a token whose scope claim is a non-string", async () => {
    const token = await signRaw({ sub: "user-1", org: "org-1", scope: 123 });

    const result = await authenticateOAuthToken(buildRequestWithToken(token));

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("authenticates a token that carries a string scope and surfaces it", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "mcp:read",
    });

    const result = await authenticateOAuthToken(buildRequestWithToken(token));

    expect(result.authenticated).toBe(true);
    expect(result.scope).toBe("mcp:read");
  });
});
