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

  // Asserting only that page is undefined would also pass if the handler
  // returned early or threw into apiError before reaching the query, since
  // an uncalled mock yields no options. Each case therefore also asserts the
  // query ran: "fell back to the default" and "refused the request" are the
  // distinction this change hinges on.
  async function optionsFor(
    query: Record<string, string>
  ): Promise<{ page?: number; limit?: number }> {
    vi.mocked(getUnifiedRuns).mockClear();
    await GET(paramsRequest(query));
    expect(getUnifiedRuns, JSON.stringify(query)).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(getUnifiedRuns).mock.calls[0] ?? [];
    return options as { page?: number; limit?: number };
  }

  it("falls back to the default for an unreadable page", async () => {
    for (const page of ["abc", "", "   ", "NaN", "1e", "--3"]) {
      expect((await optionsFor({ page })).page, `page=${page}`).toBeUndefined();
    }
  });

  it("refuses page spellings Number() would have accepted", async () => {
    // Number() reads 0x10 as 16, 1e2 as 100 and " 3" as 3, and parseInt alone
    // reads "12abc" as 12. None is a page number a caller meant.
    for (const page of ["0x10", "1e2", " 3", "3 ", "12abc", "2.9"]) {
      expect((await optionsFor({ page })).page, `page=${page}`).toBeUndefined();
    }
  });

  it("bounds a large readable page instead of scanning every run", async () => {
    // The case that did the damage: finite, so it survived a NaN check, and
    // it drove fetchLimit - the SQL LIMIT on both run sources - to every row
    // the organization holds, before slicing an empty window.
    for (const page of ["201", "999999999", "1000000000000"]) {
      expect((await optionsFor({ page })).page, `page=${page}`).toBeUndefined();
    }
  });

  it("keeps a readable page in range", async () => {
    expect((await optionsFor({ page: "1" })).page).toBe(1);
    expect((await optionsFor({ page: "4" })).page).toBe(4);
    expect((await optionsFor({ page: "200" })).page).toBe(200);
    expect((await optionsFor({ page: "0" })).page).toBeUndefined();
  });

  it("falls back for an unreadable or out-of-range limit", async () => {
    for (const limit of ["abc", "", "-5", "201", "0x20"]) {
      expect(
        (await optionsFor({ limit })).limit,
        `limit=${limit}`
      ).toBeUndefined();
    }
  });

  it("keeps a readable limit, including 0 as a count probe", async () => {
    // ?limit=0 fetches one row and returns an empty page with an accurate
    // total, which is a cheap count. Dropping it would cost a full page.
    expect((await optionsFor({ limit: "25" })).limit).toBe(25);
    expect((await optionsFor({ limit: "0" })).limit).toBe(0);
  });
});
