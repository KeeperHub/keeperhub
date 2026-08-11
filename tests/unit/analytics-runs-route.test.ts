import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authenticateOAuthTokenMock = vi.fn();

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: (...args: unknown[]) =>
    authenticateOAuthTokenMock(...args),
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: vi.fn().mockResolvedValue({ authenticated: false }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/analytics/queries", () => ({
  getUnifiedRuns: vi.fn().mockResolvedValue({
    runs: [],
    nextCursor: null,
    total: 0,
    page: 1,
    pageSize: 50,
  }),
}));

import { GET } from "@/app/api/analytics/runs/route";
import { getUnifiedRuns } from "@/lib/analytics/queries";

function oauthRequest(status: string): NextRequest {
  return {
    method: "GET",
    headers: new Headers({ Authorization: "Bearer fake-jwt" }),
    nextUrl: {
      searchParams: new URLSearchParams({ status }),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateOAuthTokenMock.mockResolvedValue({
    authenticated: true,
    userId: "user_oauth",
    organizationId: "org_from_jwt",
    scope: "mcp:read",
  });
});

describe("GET /api/analytics/runs status filter", () => {
  it("forwards system_error so the dedicated filter isolates platform failures", async () => {
    await GET(oauthRequest("system_error"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({ status: "system_error" })
    );
  });

  it("forwards external_error so the dedicated filter isolates dependency failures", async () => {
    await GET(oauthRequest("external_error"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({ status: "external_error" })
    );
  });

  it("forwards the other known statuses unchanged", async () => {
    for (const status of [
      "pending",
      "running",
      "success",
      "error",
      "cancelled",
    ]) {
      await GET(oauthRequest(status));
      expect(getUnifiedRuns).toHaveBeenLastCalledWith(
        "org_from_jwt",
        expect.anything(),
        expect.objectContaining({ status })
      );
    }
  });

  it("drops an unknown status to undefined", async () => {
    await GET(oauthRequest("bogus"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({ status: undefined })
    );
  });
});

describe("GET /api/analytics/runs auth", () => {
  it("returns 401 when OAuth token cannot resolve org", async () => {
    authenticateOAuthTokenMock.mockResolvedValueOnce({
      authenticated: false,
      statusCode: 401,
      error: "Unauthorized",
    });

    const res = await GET(oauthRequest("success"));
    expect(res.status).toBe(401);
    expect(getUnifiedRuns).not.toHaveBeenCalled();
  });

  it("returns 403 insufficient_scope when OAuth token lacks mcp:read", async () => {
    authenticateOAuthTokenMock.mockResolvedValueOnce({
      authenticated: true,
      userId: "user_oauth",
      organizationId: "org_from_jwt",
      scope: "",
    });

    const res = await GET(oauthRequest("success"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      required_scope: string;
    };
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("mcp:read");
    expect(getUnifiedRuns).not.toHaveBeenCalled();
  });

  it("resolves org from a Bearer JWT via authenticateOAuthToken", async () => {
    const res = await GET(oauthRequest("success"));

    expect(authenticateOAuthTokenMock).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({ status: "success" })
    );
  });
});
