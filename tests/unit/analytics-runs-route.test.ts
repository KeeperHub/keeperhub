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

  it("floors a fractional page rather than passing it to the offset", async () => {
    const options = await optionsFor({ page: "2.7" });

    expect(options?.page).toBe(2);
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
