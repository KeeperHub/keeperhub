import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST and DELETE here are declared governed, but the route authenticates
 * itself instead of resolving through a gated resolver, so the gate only runs
 * because the handlers ask for it. What matters is that they ask before the
 * wallet is provisioned or deactivated: a refusal after the fact is no refusal.
 */

const getSession = vi.fn();
const getActiveMember = vi.fn();
const policyRefusalFor = vi.fn();
const provisionOrganizationWallet = vi.fn();
const recordAuditEvent = vi.fn();
const deleteReturning = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession, getActiveMember } },
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("@/lib/middleware/policy-gate", () => ({ policyRefusalFor }));
vi.mock("@/lib/turnkey/provision-org-wallet", () => ({
  provisionOrganizationWallet,
}));
vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent,
  buildAuditMetadata: () => ({}),
}));
vi.mock("@/lib/middleware/org-context", () => ({
  getActiveOrgId: () => "org_1",
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(),
  auditFromAuth: () => ({}),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    delete: () => ({ where: () => ({ returning: deleteReturning }) }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  integrations: {},
  organizationWallets: {
    id: "id",
    organizationId: "organizationId",
    isActive: "isActive",
  },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE", UNKNOWN: "UNKNOWN" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
}));

const REFUSAL = {
  error: "Blocked by an organization policy",
  code: "policy_denied" as const,
  status: 403 as const,
};

function post(): Request {
  return new Request("http://localhost/api/user/wallet", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com" }),
  });
}

describe("the organization wallet route and the policy gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ user: { id: "u1", email: "u@e.com" } });
    getActiveMember.mockResolvedValue({ role: "owner" });
    policyRefusalFor.mockResolvedValue(null);
    deleteReturning.mockResolvedValue([{ id: "w1" }]);
  });

  it("refuses to provision a wallet the policy denies", async () => {
    policyRefusalFor.mockResolvedValue(REFUSAL);
    const { POST } = await import("@/app/api/user/wallet/route");

    const response = await POST(post());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "policy_denied",
    });
    expect(provisionOrganizationWallet).not.toHaveBeenCalled();
  });

  it("refuses to deactivate a wallet the policy denies", async () => {
    policyRefusalFor.mockResolvedValue(REFUSAL);
    const { DELETE } = await import("@/app/api/user/wallet/route");

    const response = await DELETE(
      new Request("http://localhost/api/user/wallet", { method: "DELETE" })
    );

    expect(response.status).toBe(403);
    expect(deleteReturning).not.toHaveBeenCalled();
  });

  it("asks about the organization and the acting user, not a placeholder", async () => {
    const { POST } = await import("@/app/api/user/wallet/route");
    await POST(post());

    expect(policyRefusalFor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org_1", userId: "u1" })
    );
  });
});
