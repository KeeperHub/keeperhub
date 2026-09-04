import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authenticateOAuthTokenMock = vi.fn();

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: (...args: unknown[]) =>
    authenticateOAuthTokenMock(...args),
}));

const authenticateApiKeyMock = vi.fn();

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: (...args: unknown[]) => authenticateApiKeyMock(...args),
}));

vi.mock("@/lib/analytics/queries", () => ({
  getAnalyticsSummary: vi.fn().mockResolvedValue({
    totalRuns: 0,
    successRate: 0,
  }),
}));

const getSessionMock = vi.fn();
const mockOrgRow = { deactivatedAt: null };

vi.mock("next/headers", () => ({
  headers: () => new Headers(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
        where: vi.fn(() => ({
          limit: vi.fn(async () => [mockOrgRow]),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
      getFullOrganization: vi.fn(async () => ({
        id: "org_anon",
        name: "Anon Org",
        slug: "anon-org",
        logo: null,
        metadata: null,
        createdAt: new Date(),
      })),
      getActiveMember: vi.fn(async () => null),
    },
  },
}));

import { GET } from "@/app/api/analytics/summary/route";
import { getAnalyticsSummary } from "@/lib/analytics/queries";

function request(authHeader: string | null): NextRequest {
  return {
    method: "GET",
    headers: new Headers(
      authHeader ? { Authorization: authHeader } : undefined
    ),
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(null);
  authenticateOAuthTokenMock.mockResolvedValue({
    authenticated: false,
    statusCode: 401,
    error: "Unauthorized",
  });
  authenticateApiKeyMock.mockResolvedValue({ authenticated: false });
});

describe("GET /api/analytics/summary auth (session-only -> dual auth)", () => {
  it("rejects when no credential resolves an organization", async () => {
    const res = await GET(request(null));
    expect(res.status).toBe(401);
    expect(getAnalyticsSummary).not.toHaveBeenCalled();
  });

  it("accepts a Bearer kh_ API key via authenticateApiKey", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_key",
      organizationId: "org_from_key",
      apiKeyId: "key_1",
      scope: "mcp:read",
    });

    const res = await GET(request("Bearer kh_test_123"));
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalled();
    expect(getAnalyticsSummary).toHaveBeenCalledWith(
      "org_from_key",
      expect.anything(),
      undefined,
      undefined,
      undefined
    );
  });

  it("admits an unscoped API key (scope undefined = legacy full access)", async () => {
    // parseScopeInput never returns an empty string, and api-key-auth maps a
    // null scope column to undefined, so scope: "" cannot occur. The real
    // unscoped-key case is scope: undefined, which scopeSatisfies admits as
    // full access for backwards compatibility. Pin that behaviour so a future
    // change to scopeSatisfies breaks this test instead of silently narrowing
    // every unscoped key.
    authenticateApiKeyMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_key",
      organizationId: "org_from_key",
      apiKeyId: "key_1",
      scope: undefined,
    });

    const res = await GET(request("Bearer kh_test_123"));
    expect(res.status).toBe(200);
    expect(getAnalyticsSummary).toHaveBeenCalledWith(
      "org_from_key",
      expect.anything(),
      undefined,
      undefined,
      undefined
    );
  });

  it("keeps resolving org from an OAuth Bearer JWT", async () => {
    authenticateOAuthTokenMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_oauth",
      organizationId: "org_from_jwt",
      scope: "mcp:read",
    });

    const res = await GET(request("Bearer fake-jwt"));
    expect(res.status).toBe(200);
    expect(getAnalyticsSummary).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      undefined,
      undefined,
      undefined
    );
  });

  it("rejects 401 when the session belongs to an anonymous user", async () => {
    // OAuth and API-key auth both fail; the session branch resolves. The
    // route rejects anonymous sessions at route level. The rejection lives on
    // the route rather than in the shared resolver, which 26 routes call -
    // several of which exist to serve anonymous visitors. (The previous
    // requireOrganization wrapper did not in fact reject anonymous sessions,
    // which resolve to their own throwaway org; the check is kept to match
    // the sidebar, which hides Analytics from anonymous users.)
    // getSession is called twice on this path (once by resolveOrganizationId,
    // once by getOrgContext), so the mock must persist for both calls.
    getSessionMock.mockResolvedValue({
      user: {
        id: "anon_1",
        name: "Anonymous",
        email: "temp-anon@keeperhub.com",
      },
      session: { activeOrganizationId: "org_anon" },
    });

    const res = await GET(request(null));
    expect(res.status).toBe(401);
    expect(getAnalyticsSummary).not.toHaveBeenCalled();
  });
});
