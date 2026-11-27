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

vi.mock("@/lib/analytics/rpc-usage", () => ({
  getRpcUsage: vi.fn().mockResolvedValue({ ownRpcOnly: false }),
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
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [mockOrgRow]) })),
        })),
        where: vi.fn(() => ({ limit: vi.fn(async () => [mockOrgRow]) })),
      })),
    })),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
      getFullOrganization: vi.fn(async () => null),
      getActiveMember: vi.fn(async () => null),
    },
  },
}));

import { GET } from "@/app/api/analytics/rpc-usage/route";
import { getRpcUsage } from "@/lib/analytics/rpc-usage";

function request(
  authHeader: string | null,
  query: Record<string, string> = {}
): NextRequest {
  return {
    method: "GET",
    headers: new Headers(
      authHeader ? { Authorization: authHeader } : undefined
    ),
    nextUrl: { searchParams: new URLSearchParams(query) },
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

describe("GET /api/analytics/rpc-usage auth", () => {
  it("rejects when no credential resolves an organization", async () => {
    const res = await GET(request(null));
    expect(res.status).toBe(401);
    expect(getRpcUsage).not.toHaveBeenCalled();
  });

  it("serves an API key with mcp:read the key's organization", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_key",
      organizationId: "org_from_key",
      apiKeyId: "key_1",
      scope: "mcp:read",
    });

    const res = await GET(
      request("Bearer kh_test_123", {
        range: "7d",
        tz: "Europe/Berlin",
      })
    );
    expect(res.status).toBe(200);
    expect(getRpcUsage).toHaveBeenCalledWith(
      "org_from_key",
      "7d",
      undefined,
      undefined,
      "Europe/Berlin"
    );
  });

  it("denies 403 insufficient_scope when the token lacks mcp:read", async () => {
    authenticateOAuthTokenMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_oauth",
      organizationId: "org_from_jwt",
      scope: "",
    });

    const res = await GET(request("Bearer fake-jwt"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required_scope: string };
    expect(body.required_scope).toBe("mcp:read");
    expect(getRpcUsage).not.toHaveBeenCalled();
  });

  it("passes a custom range through and falls back to UTC on a bad zone", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_key",
      organizationId: "org_from_key",
      apiKeyId: "key_1",
      scope: undefined,
    });

    await GET(
      request("Bearer kh_test_123", {
        range: "custom",
        customStart: "2026-01-01T00:00:00.000Z",
        customEnd: "2026-01-02T00:00:00.000Z",
        tz: "+03:00",
      })
    );
    expect(getRpcUsage).toHaveBeenCalledWith(
      "org_from_key",
      "custom",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "UTC"
    );
  });
});
