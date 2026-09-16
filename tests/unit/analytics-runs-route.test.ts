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
      expect.objectContaining({ statuses: ["system_error"] })
    );
  });

  it("forwards external_error so the dedicated filter isolates dependency failures", async () => {
    await GET(oauthRequest("external_error"));

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({ statuses: ["external_error"] })
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
        expect.objectContaining({ statuses: [status] })
      );
    }
  });

  it("drops an unknown status rather than narrowing on it", async () => {
    await GET(oauthRequest("bogus"));

    const [, , options] = vi.mocked(getUnifiedRuns).mock.calls[0] ?? [];
    expect(options?.statuses).toBeUndefined();
  });

  it("forwards every status of a multi-select as one union", async () => {
    const params = new URLSearchParams();
    params.append("status", "error");
    params.append("status", "external_error");
    params.append("status", "system_error");
    await GET({
      method: "GET",
      headers: new Headers({ Authorization: "Bearer fake-jwt" }),
      nextUrl: { searchParams: params },
    } as unknown as NextRequest);

    expect(getUnifiedRuns).toHaveBeenCalledWith(
      "org_from_jwt",
      expect.anything(),
      expect.objectContaining({
        statuses: ["error", "external_error", "system_error"],
      })
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
      expect.objectContaining({ statuses: ["success"] })
    );
  });
});

describe("GET /api/analytics/runs pagination parsing", () => {
  function paramsRequest(query: Record<string, string>): NextRequest {
    return {
      method: "GET",
      headers: new Headers({ Authorization: "Bearer fake-jwt" }),
      nextUrl: { searchParams: new URLSearchParams(query) },
    } as unknown as NextRequest;
  }

  const optionsOf = () => {
    const [, , options] = vi.mocked(getUnifiedRuns).mock.calls[0] ?? [];
    return options as { page?: number; limit?: number } | undefined;
  };

  it("drops an unreadable page instead of passing NaN through", async () => {
    // getUnifiedRuns computes offset = (page - 1) * pageLimit, so a NaN page
    // sliced to nothing and answered with zero runs beside a non-zero total,
    // which reads as data loss rather than a rejected parameter.
    for (const page of ["abc", "", "   ", "NaN", "1e", "--3"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      await GET(paramsRequest({ page }));
      expect(optionsOf()?.page, `page=${JSON.stringify(page)}`).toBeUndefined();
    }
  });

  it("keeps a readable page, floored and never below one", async () => {
    for (const [raw, expected] of [
      ["1", 1],
      ["4", 4],
      ["2.9", 2],
      ["0", 1],
    ] as const) {
      vi.mocked(getUnifiedRuns).mockClear();
      await GET(paramsRequest({ page: raw }));
      expect(optionsOf()?.page, `page=${raw}`).toBe(expected);
    }
  });

  it("drops an unreadable or meaningless limit the same way", async () => {
    for (const limit of ["abc", "", "0", "-5"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      await GET(paramsRequest({ limit }));
      expect(
        optionsOf()?.limit,
        `limit=${JSON.stringify(limit)}`
      ).toBeUndefined();
    }
  });

  it("keeps a readable limit", async () => {
    vi.mocked(getUnifiedRuns).mockClear();
    await GET(paramsRequest({ limit: "25" }));
    expect(optionsOf()?.limit).toBe(25);
  });
});
