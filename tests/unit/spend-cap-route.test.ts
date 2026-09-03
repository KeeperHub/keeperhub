import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const resolveOrganizationIdMock = vi.fn();

vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveOrganizationId: (...args: unknown[]) =>
    resolveOrganizationIdMock(...args),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: (grantedScope: string | undefined, required: string) => {
    if (grantedScope === "mcp:read" || grantedScope === undefined) {
      return null;
    }
    return new Response(
      JSON.stringify({ error: "insufficient_scope", required_scope: required }),
      { status: 403 }
    );
  },
}));

// PUT remains session-gated via requirePermission.
vi.mock("@/lib/middleware/require-org", () => ({
  requirePermission:
    (
      _resource: string,
      _actions: string[],
      handler: (req: NextRequest, context: unknown) => Promise<Response>
    ) =>
    (req: NextRequest) =>
      handler(req, { organization: { id: "org_1" } }),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (_e: unknown, message: string) =>
    new Response(JSON.stringify({ error: message }), { status: 500 }),
}));

vi.mock("@/lib/db/schema", () => ({
  organizationSpendCaps: { organizationId: "organization_id" },
}));

vi.mock("@/lib/analytics/queries", () => ({
  getSpendCapData: vi.fn().mockResolvedValue({
    dailyCapWei: "1000",
    dailyUsedWei: "10",
    dailySolanaCapLamports: "2000000000",
    dailySolanaUsedLamports: "5",
  }),
}));

// Captures what the route actually writes, which is the whole point: the `set`
// object decides which columns are overwritten.
const written = vi.hoisted(() => ({
  values: null as Record<string, unknown> | null,
  set: null as Record<string, unknown> | null,
  calls: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        written.values = v;
        return {
          onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
            written.set = arg.set;
            written.calls += 1;
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  },
}));

import { GET, PUT } from "@/app/api/analytics/spend-cap/route";

function putRequest(body: unknown): NextRequest {
  return {
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function malformedRequest(): NextRequest {
  return {
    json: () => Promise.reject(new Error("bad json")),
  } as unknown as NextRequest;
}

beforeEach(() => {
  written.values = null;
  written.set = null;
  written.calls = 0;
  resolveOrganizationIdMock.mockResolvedValue({
    organizationId: "org_1",
    scope: "mcp:read",
    authMethod: "oauth",
    apiKeyId: null,
  });
});

describe("GET /api/analytics/spend-cap", () => {
  it("returns both caps and both usage figures", async () => {
    const res = await GET({} as NextRequest);
    const body = (await res.json()) as Record<string, unknown>;

    // Each chain family reports its own cap and its own usage; sharing either
    // would misreport both gauges.
    expect(body).toEqual({
      dailyCapWei: "1000",
      dailyUsedWei: "10",
      dailySolanaCapLamports: "2000000000",
      dailySolanaUsedLamports: "5",
    });
  });

  it("returns 401 when OAuth token cannot resolve org", async () => {
    resolveOrganizationIdMock.mockResolvedValueOnce({
      error: "Unauthorized",
      status: 401,
    });
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/analytics/spend-cap partial updates", () => {
  it("writing only the Solana cap does NOT touch the wei cap", async () => {
    const res = await PUT(
      putRequest({ dailySolanaValueCapLamports: "2000000000" })
    );

    expect(res.status).toBe(200);
    // The regression this guards: if dailyValueCapWei appeared in `set`, saving
    // the Solana cap from its own control would silently clear the EVM cap.
    expect(written.set).not.toHaveProperty("dailyValueCapWei");
    expect(written.set).toMatchObject({
      dailySolanaValueCapLamports: "2000000000",
    });
  });

  it("writing only the wei cap does NOT touch the Solana cap", async () => {
    const res = await PUT(putRequest({ dailyValueCapWei: "1000" }));

    expect(res.status).toBe(200);
    expect(written.set).not.toHaveProperty("dailySolanaValueCapLamports");
    expect(written.set).toMatchObject({ dailyValueCapWei: "1000" });
  });

  it("writes both columns when both fields are supplied", async () => {
    await PUT(
      putRequest({
        dailyValueCapWei: "1000",
        dailySolanaValueCapLamports: "2000000000",
      })
    );

    expect(written.set).toMatchObject({
      dailyValueCapWei: "1000",
      dailySolanaValueCapLamports: "2000000000",
    });
  });

  it("treats an explicit null as a clear, distinct from omission", async () => {
    await PUT(putRequest({ dailySolanaValueCapLamports: null }));

    // Present-but-null must reach the column as null (clear), while the
    // omitted wei cap stays absent (unchanged).
    expect(written.set).toHaveProperty("dailySolanaValueCapLamports", null);
    expect(written.set).not.toHaveProperty("dailyValueCapWei");
  });

  it("echoes back only the fields that were supplied", async () => {
    const res = await PUT(
      putRequest({ dailySolanaValueCapLamports: "2000000000" })
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({ dailySolanaValueCapLamports: "2000000000" });
  });
});

describe("PUT /api/analytics/spend-cap validation", () => {
  it("rejects an empty body rather than writing nothing silently", async () => {
    const res = await PUT(putRequest({}));

    expect(res.status).toBe(400);
    expect(written.calls).toBe(0);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await PUT(malformedRequest());

    expect(res.status).toBe(400);
    expect(written.calls).toBe(0);
  });

  it.each([
    ["a negative value", "-5"],
    ["a decimal value", "1.5"],
    ["a non-numeric string", "abc"],
    ["a number instead of a string", 1000],
    ["a boolean", true],
  ])("rejects %s for the wei cap and writes nothing", async (_label, value) => {
    const res = await PUT(putRequest({ dailyValueCapWei: value }));
    const body = (await res.json()) as Record<string, unknown>;

    // Rejected rather than coerced: a malformed cap must never be silently
    // stored, and must never fall through to "unlimited".
    expect(res.status).toBe(400);
    expect(body.field).toBe("dailyValueCapWei");
    expect(written.calls).toBe(0);
  });

  it.each([
    ["a negative value", "-1"],
    ["a decimal value", "0.5"],
    ["a non-numeric string", "1e9"],
  ])("rejects %s for the Solana cap and writes nothing", async (_label, value) => {
    const res = await PUT(putRequest({ dailySolanaValueCapLamports: value }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.field).toBe("dailySolanaValueCapLamports");
    expect(written.calls).toBe(0);
  });

  it("rejects the whole request when one of two fields is malformed", async () => {
    const res = await PUT(
      putRequest({
        dailyValueCapWei: "1000",
        dailySolanaValueCapLamports: "-1",
      })
    );

    // Partial application would leave the caps in a state the admin did not
    // ask for, so a bad field rejects the request outright.
    expect(res.status).toBe(400);
    expect(written.calls).toBe(0);
  });
});
