import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const URL_ORG_ID = "org-target";
const KEY_ORG_ID = "org-key-home";
const USER_ID = "user-1";

const { mockGetDualAuthContext, mockOwnerSelectLimit, mockUpdateReturning } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockOwnerSelectLimit: vi.fn(),
    mockUpdateReturning: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
  auditFromAuth: (ctx: unknown): Record<string, string> => {
    if (ctx && typeof ctx === "object" && "error" in ctx) {
      return { authMethod: "unknown" };
    }
    const c = ctx as { authMethod: string; apiKeyId?: string | null };
    return c.apiKeyId
      ? { authMethod: c.authMethod, apiKeyId: c.apiKeyId }
      : { authMethod: c.authMethod };
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockOwnerSelectLimit,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
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
  organization: { id: "id", name: "name" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { PATCH } from "@/app/api/organizations/[organizationId]/route";

function buildRequest(body: unknown): Request {
  return new Request(`http://localhost/api/organizations/${URL_ORG_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildContext(): { params: Promise<{ organizationId: string }> } {
  return { params: Promise.resolve({ organizationId: URL_ORG_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/organizations/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 when API key has no recorded creator", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: URL_ORG_ID,
      authMethod: "api-key",
    });

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(400);
  });

  it("rejects API-key caller with 403 when key home org differs from URL org", async () => {
    // Cross-org API-key call: key issued for KEY_ORG_ID but URL targets
    // URL_ORG_ID. The owner-membership query never runs.
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: KEY_ORG_ID,
      authMethod: "api-key",
    });

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(403);
    expect(mockOwnerSelectLimit).not.toHaveBeenCalled();
  });

  it("permits session caller whose active org differs from URL org when they own the URL org", async () => {
    // Regression guard: a session user can be owner of multiple orgs and
    // PATCH an org other than their currently-active session org. The
    // owner-membership query is the authoritative gate for sessions.
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: KEY_ORG_ID,
      authMethod: "session",
    });
    mockOwnerSelectLimit.mockResolvedValue([{ id: "member-1" }]);
    mockUpdateReturning.mockResolvedValue([
      { id: URL_ORG_ID, name: "New Name" },
    ]);

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.organization.id).toBe(URL_ORG_ID);
  });

  it("returns 403 when caller is not an owner of the URL org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "session",
    });
    mockOwnerSelectLimit.mockResolvedValue([]);

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(403);
  });

  it("permits API-key caller whose home org matches the URL org when creator is owner", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "api-key",
    });
    mockOwnerSelectLimit.mockResolvedValue([{ id: "member-1" }]);
    mockUpdateReturning.mockResolvedValue([
      { id: URL_ORG_ID, name: "New Name" },
    ]);

    const response = await PATCH(
      buildRequest({ name: "New Name" }),
      buildContext()
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 when name is missing", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: URL_ORG_ID,
      authMethod: "session",
    });

    const response = await PATCH(buildRequest({}), buildContext());
    expect(response.status).toBe(400);
  });
});
