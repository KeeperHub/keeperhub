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

describe("GET /api/analytics/runs pagination parsing", () => {
  function paginationRequest(query: Record<string, string>): NextRequest {
    return {
      method: "GET",
      headers: new Headers({ Authorization: "Bearer fake-jwt" }),
      nextUrl: { searchParams: new URLSearchParams(query) },
    } as unknown as NextRequest;
  }

  async function optionsFor(
    query: Record<string, string>
  ): Promise<Record<string, unknown> | undefined> {
    await GET(paginationRequest(query));
    const [, , options] = vi.mocked(getUnifiedRuns).mock.calls[0] ?? [];
    return options as Record<string, unknown> | undefined;
  }

  it("drops a non-numeric page rather than forwarding NaN", async () => {
    // Math.max(1, NaN) is NaN, so the old parse reached the query as NaN: the
    // offset became NaN, slice(NaN, NaN) returned nothing, and the echoed page
    // serialized as null. The response was zero runs beside a non-zero total,
    // which reads as data loss rather than as a rejected parameter.
    const options = await optionsFor({ page: "abc" });

    expect(options?.page).toBeUndefined();
    expect(options?.page).not.toBeNaN();
  });

  it("drops a non-numeric limit, which Math.min does not cap either", async () => {
    // Math.min(NaN, 100) is also NaN, so limit had the same failure despite
    // the cap downstream.
    const options = await optionsFor({ limit: "abc" });

    expect(options?.limit).toBeUndefined();
    expect(options?.limit).not.toBeNaN();
  });

  it("forwards a valid page and limit unchanged", async () => {
    const options = await optionsFor({ page: "3", limit: "25" });

    expect(options?.page).toBe(3);
    expect(options?.limit).toBe(25);
  });

  it("drops a fractional page rather than reinterpreting it", async () => {
    // parseInt would read "2.7" as 2, which is not the page the caller wrote.
    // The exact round-trip rejects it, so it falls back to the default.
    const options = await optionsFor({ page: "2.7" });

    expect(options?.page).toBeUndefined();
  });

  it("drops notations Number() would silently reinterpret", async () => {
    // Number() reads these as 16, 3 and 1e+302. None is what a caller writing
    // a page number meant, and 1e302 reaches Postgres as a bigint cast error.
    for (const page of ["0x10", " 3 ", "1e302", "12abc"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      const options = await optionsFor({ page });
      expect(options?.page, `page=${page}`).toBeUndefined();
    }
  });

  it("clamps a page past the ceiling instead of unbounding the SQL LIMIT", async () => {
    // getUnifiedRuns turns the page into
    // fetchLimit = (page - 1) * pageLimit + pageLimit + 1, and that becomes the
    // LIMIT on both source queries. page=999999999 asks for 49999999951 rows -
    // every run in range - then slices an empty window out of them.
    for (const page of ["999999999", "201"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      const options = await optionsFor({ page });
      expect(options?.page, `page=${page}`).toBe(200);
    }
  });

  it("clamps rather than dropping, so the pager and the rows agree", async () => {
    // Dropping is indistinguishable from absent, so getUnifiedRuns would fall
    // back to page 1 and echo it. The table computes totalPages from the real
    // total and keeps Next enabled past the ceiling, so an org with more than
    // 10000 runs in range would page to 201 and silently receive rows 1-50
    // while the pager still read 10001-10050.
    const options = await optionsFor({ page: "201" });

    expect(options?.page).not.toBe(1);
    expect(options?.page).toBe(200);
  });

  it("drops a page too large to round-trip rather than clamping a value the caller never wrote", async () => {
    // 9007199254740993 parses to ...992, so the string does not round-trip and
    // the value is not the one that was sent.
    const options = await optionsFor({ page: "9007199254740993" });

    expect(options?.page).toBeUndefined();
  });

  it("accepts the largest page it will honour", async () => {
    const options = await optionsFor({ page: "200" });

    expect(options?.page).toBe(200);
  });

  it("clamps a limit to the figure the query actually honours", async () => {
    // getUnifiedRuns computes pageLimit as Math.min(limit, 100), so validating
    // against anything larger admits a value it then halves: ?limit=150 was
    // accepted and served 100.
    for (const limit of ["100000", "150", "200"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      const options = await optionsFor({ limit });
      expect(options?.limit, `limit=${limit}`).toBe(100);
    }
  });

  it("keeps the worst-case fetchLimit at the figure the comment claims", async () => {
    // fetchLimit = (page - 1) * pageLimit + pageLimit + 1, with pageLimit
    // capped at 100 by the query. The ceilings only agree when limit is bound
    // at 100 too; bound at 200 the arithmetic in the comment was wrong.
    const options = await optionsFor({ page: "999999", limit: "250" });
    const page = options?.page as number;
    const pageLimit = Math.min((options?.limit as number) ?? 50, 100);

    expect((page - 1) * pageLimit + pageLimit + 1).toBe(20_001);
  });

  it("drops a page below the first one instead of clamping silently", async () => {
    // A falsy "0" also took the undefined branch before; a negative did not,
    // and Math.max carried it to 1. Both now read as absent, so the query
    // applies its own default.
    for (const page of ["0", "-3"]) {
      vi.mocked(getUnifiedRuns).mockClear();
      const options = await optionsFor({ page });
      expect(options?.page).toBeUndefined();
    }
  });

  it("drops a limit of zero, which would otherwise request an empty page", async () => {
    const options = await optionsFor({ limit: "0" });

    expect(options?.limit).toBeUndefined();
  });

  it("treats an empty page parameter as absent", async () => {
    // A templated client can render `?page=` with nothing in it.
    const options = await optionsFor({ page: "" });

    expect(options?.page).toBeUndefined();
  });

  it("leaves pagination unset when neither parameter is sent", async () => {
    const options = await optionsFor({});

    expect(options?.page).toBeUndefined();
    expect(options?.limit).toBeUndefined();
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
