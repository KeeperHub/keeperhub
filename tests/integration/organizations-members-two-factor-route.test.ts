import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const URL_ORG_ID = "org-target";
const KEY_ORG_ID = "org-key-home";
const USER_ID = "user-1";

const { mockGetDualAuthContext, mockMembershipLimit, mockStatusesWhere } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockMembershipLimit: vi.fn(),
    mockStatusesWhere: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
  auditFromAuth: (ctx: unknown): Record<string, string> => {
    if (ctx && typeof ctx === "object" && "error" in ctx) {
      return { authMethod: "unknown" };
    }
    const c = ctx as { authMethod: string };
    return { authMethod: c.authMethod };
  },
}));

// The route runs two queries: the membership-role lookup ends in .limit(),
// the statuses lookup joins users and is awaited straight off .where().
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockMembershipLimit })),
        innerJoin: vi.fn(() => ({ where: mockStatusesWhere })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "id",
    organizationId: "organization_id",
    userId: "user_id",
    role: "role",
  },
  users: { id: "id", twoFactorEnabled: "two_factor_enabled" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/organizations/[organizationId]/members/two-factor/route";

function buildRequest(): Request {
  return new Request(
    `http://localhost/api/organizations/${URL_ORG_ID}/members/two-factor`
  );
}

function buildContext(): { params: Promise<{ organizationId: string }> } {
  return { params: Promise.resolve({ organizationId: URL_ORG_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/organizations/[id]/members/two-factor", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(401);
  });

  it("returns 400 when API key has no recorded creator", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: URL_ORG_ID,
      authMethod: "api-key",
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(400);
  });

  it("rejects API-key caller whose home org differs from URL org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: KEY_ORG_ID,
      authMethod: "api-key",
    });

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(403);
    expect(mockMembershipLimit).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a plain member of the org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "session",
    });
    mockMembershipLimit.mockResolvedValue([{ role: "member" }]);

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(403);
    expect(mockStatusesWhere).not.toHaveBeenCalled();
  });

  it("returns a status map keyed by user id for an owner", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "session",
    });
    mockMembershipLimit.mockResolvedValue([{ role: "owner" }]);
    mockStatusesWhere.mockResolvedValue([
      { userId: "user-1", twoFactorEnabled: true },
      { userId: "user-2", twoFactorEnabled: false },
      { userId: "user-3", twoFactorEnabled: null },
    ]);

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.statuses).toEqual({
      "user-1": true,
      "user-2": false,
      "user-3": false,
    });
  });

  it("permits an admin caller", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "session",
    });
    mockMembershipLimit.mockResolvedValue([{ role: "admin" }]);
    mockStatusesWhere.mockResolvedValue([]);

    const response = await GET(buildRequest(), buildContext());
    expect(response.status).toBe(200);
  });
});
