import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getOrgContext: vi.fn(),
  hasPermission: vi.fn(),
  upsertValues: vi.fn(),
  upsertConflict: vi.fn(),
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: (...args: unknown[]) => mocks.getOrgContext(...args),
  getActiveOrgId: vi.fn(),
  hasPermission: (...args: unknown[]) => mocks.hasPermission(...args),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        mocks.upsertValues(v);
        return {
          onConflictDoUpdate: (c: unknown) => {
            mocks.upsertConflict(c);
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  },
}));

import { PUT } from "@/app/api/analytics/spend-cap/route";

const ORG_ID = "org-1";

function putRequest(body: unknown): Parameters<typeof PUT>[0] {
  return new Request("http://localhost/api/analytics/spend-cap", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as Parameters<typeof PUT>[0];
}

function authedContext(role = "admin"): Record<string, unknown> {
  return {
    user: { id: "user-1", email: "a@example.com", name: "A", image: null },
    organization: { id: ORG_ID, name: "Org", createdAt: new Date() },
    member: {
      id: "m-1",
      organizationId: ORG_ID,
      userId: "user-1",
      role,
      createdAt: new Date(),
    },
    isAnonymous: false,
    needsOrganization: false,
  };
}

describe("PUT /api/analytics/spend-cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrgContext.mockResolvedValue(authedContext());
    mocks.hasPermission.mockResolvedValue(true);
  });

  it("returns 401 for an anonymous session", async () => {
    mocks.getOrgContext.mockResolvedValue({
      user: null,
      organization: null,
      member: null,
      isAnonymous: true,
      needsOrganization: false,
    });

    const res = await PUT(putRequest({ dailyValueCapWei: "1000" }));

    expect(res.status).toBe(401);
    expect(mocks.upsertValues).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks organization:update (e.g. a member)", async () => {
    mocks.getOrgContext.mockResolvedValue(authedContext("member"));
    mocks.hasPermission.mockResolvedValue(false);

    const res = await PUT(putRequest({ dailyValueCapWei: "1000" }));

    expect(res.status).toBe(403);
    expect(mocks.hasPermission).toHaveBeenCalledWith("organization", [
      "update",
    ]);
    expect(mocks.upsertValues).not.toHaveBeenCalled();
  });

  it("rejects a non-integer / negative cap with 400", async () => {
    for (const bad of ["-5", "1.5", "abc", 1000]) {
      const res = await PUT(putRequest({ dailyValueCapWei: bad }));
      expect(res.status).toBe(400);
    }
    expect(mocks.upsertValues).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await PUT(putRequest("{not json"));
    expect(res.status).toBe(400);
    expect(mocks.upsertValues).not.toHaveBeenCalled();
  });

  it("upserts the org's value cap and returns 200", async () => {
    const res = await PUT(
      putRequest({ dailyValueCapWei: "1000000000000000000" })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ dailyValueCapWei: "1000000000000000000" });
    expect(mocks.upsertValues).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      dailyValueCapWei: "1000000000000000000",
      dailySolanaValueCapLamports: null,
    });
    expect(mocks.upsertConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          dailyValueCapWei: "1000000000000000000",
        }),
      })
    );
  });

  it("clears the cap when dailyValueCapWei is null", async () => {
    const res = await PUT(putRequest({ dailyValueCapWei: null }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ dailyValueCapWei: null });
    expect(mocks.upsertValues).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      dailyValueCapWei: null,
      dailySolanaValueCapLamports: null,
    });
  });
});
