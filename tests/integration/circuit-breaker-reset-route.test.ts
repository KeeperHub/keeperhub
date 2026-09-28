import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getOrgContext: vi.fn(),
  hasPermission: vi.fn(),
  resetOrgCircuitBreaker: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: (...args: unknown[]) => mocks.getOrgContext(...args),
  getActiveOrgId: vi.fn(),
  hasPermission: (...args: unknown[]) => mocks.hasPermission(...args),
}));

vi.mock("@/lib/execute/org-circuit-breaker", () => ({
  resetOrgCircuitBreaker: (...args: unknown[]) =>
    mocks.resetOrgCircuitBreaker(...args),
}));

vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: (...args: unknown[]) => mocks.recordAuditEvent(...args),
  buildAuditMetadata: () => ({}),
}));

import { POST } from "@/app/api/organizations/circuit-breaker/reset/route";

const ORG_ID = "org-1";
const USER_ID = "user-1";

function postRequest(): Parameters<typeof POST>[0] {
  return new Request(
    "http://localhost/api/organizations/circuit-breaker/reset",
    {
      method: "POST",
    }
  ) as Parameters<typeof POST>[0];
}

function authedContext(role = "admin"): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: "a@example.com", name: "A", image: null },
    organization: { id: ORG_ID, name: "Org", createdAt: new Date() },
    member: {
      id: "m-1",
      organizationId: ORG_ID,
      userId: USER_ID,
      role,
      createdAt: new Date(),
    },
    isAnonymous: false,
    needsOrganization: false,
  };
}

const ANONYMOUS = {
  user: null,
  organization: null,
  member: null,
  isAnonymous: true,
  needsOrganization: false,
};

describe("POST /api/organizations/circuit-breaker/reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrgContext.mockResolvedValue(authedContext());
    mocks.hasPermission.mockResolvedValue(true);
    mocks.resetOrgCircuitBreaker.mockResolvedValue({
      reset: true,
      wasHalted: true,
    });
  });

  it("rejects a request with no org session (e.g. a kh_ API key) with 401", async () => {
    // getOrgContext resolves the better-auth session only; a kh_ key carries no
    // session, so it surfaces here as anonymous and never reaches the reset.
    mocks.getOrgContext.mockResolvedValue(ANONYMOUS);

    const res = await POST(postRequest());

    expect(res.status).toBe(401);
    expect(mocks.resetOrgCircuitBreaker).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks organization:update (e.g. a member)", async () => {
    mocks.getOrgContext.mockResolvedValue(authedContext("member"));
    mocks.hasPermission.mockResolvedValue(false);

    const res = await POST(postRequest());

    expect(res.status).toBe(403);
    expect(mocks.hasPermission).toHaveBeenCalledWith("organization", [
      "update",
    ]);
    expect(mocks.resetOrgCircuitBreaker).not.toHaveBeenCalled();
  });

  it("clears the breaker for an admin and returns 200 with the prior state", async () => {
    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true, wasHalted: true });
    expect(mocks.resetOrgCircuitBreaker).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      requestedByUserId: USER_ID,
    });
    expect(mocks.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 403 if the deeper role check denies the reset", async () => {
    mocks.resetOrgCircuitBreaker.mockResolvedValue({
      reset: false,
      reason: "not_authorized",
    });

    const res = await POST(postRequest());

    expect(res.status).toBe(403);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });
});
