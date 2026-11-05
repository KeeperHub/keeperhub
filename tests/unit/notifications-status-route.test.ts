import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDualAuthContext: vi.fn(),
  getOrgRole: vi.fn(),
  loadInAppAlertState: vi.fn(),
  isFailureAlertsEnabledForOrg: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mocks.getDualAuthContext,
}));
vi.mock("@/lib/security/org-role", () => ({ getOrgRole: mocks.getOrgRole }));
vi.mock("@/lib/notifications/failure-alerts/settings", () => ({
  loadInAppAlertState: mocks.loadInAppAlertState,
}));
vi.mock("@/lib/notifications/failure-alerts/rollout", () => ({
  isFailureAlertsEnabledForOrg: mocks.isFailureAlertsEnabledForOrg,
}));
vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: () => false,
}));
vi.mock("@/lib/billing/limit-status", () => ({
  isBillingLimitReached: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE", INFRASTRUCTURE: "INFRASTRUCTURE" },
  logSystemWarn: vi.fn(),
}));

import { GET } from "@/app/api/notifications/status/route";

function request(orgId: string): Request {
  return new Request("http://localhost/api/notifications/status", {
    headers: { "X-Organization-Id": orgId },
  });
}

describe("GET /api/notifications/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInAppAlertState.mockResolvedValue({
      failingWorkflows: 0,
      unreachable: true,
      pausedUntil: "2026-11-05T14:04:00.000Z",
    });
    mocks.isFailureAlertsEnabledForOrg.mockImplementation(
      (id: string) => id === "org-b"
    );
  });

  it("answers for the org the caller names, with the role held there", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "u1",
      organizationId: "org-b",
      authMethod: "session",
      apiKeyId: null,
    });
    mocks.getOrgRole.mockResolvedValue("admin");

    const body = await (await GET(request("org-b"))).json();

    expect(mocks.getOrgRole).toHaveBeenCalledWith("u1", "org-b");
    expect(mocks.loadInAppAlertState).toHaveBeenCalledWith("org-b");
    expect(body).toEqual({
      unreadCount: 1,
      types: ["failure_alerts_unreachable"],
      alertsEnabled: true,
      alertsPausedUntil: "2026-11-05T14:04:00.000Z",
    });
  });

  it("answers empty when the caller is not a member of the named org", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      error: "Organization not found",
      code: "NOT_FOUND",
      status: 404,
    });

    const body = await (await GET(request("org-x"))).json();

    expect(body).toEqual({
      unreadCount: 0,
      types: [],
      alertsEnabled: false,
      alertsPausedUntil: null,
    });
    expect(mocks.loadInAppAlertState).not.toHaveBeenCalled();
  });

  it("shows a plain member the paused and nobody-reachable banners, not the failing notice", async () => {
    mocks.getDualAuthContext.mockResolvedValue({
      userId: "u1",
      organizationId: "org-b",
      authMethod: "session",
      apiKeyId: null,
    });
    mocks.getOrgRole.mockResolvedValue("member");
    mocks.loadInAppAlertState.mockResolvedValue({
      failingWorkflows: 2,
      unreachable: true,
      pausedUntil: "2026-11-05T14:04:00.000Z",
    });

    const body = await (await GET(request("org-b"))).json();

    expect(body.types).toEqual(["failure_alerts_unreachable"]);
    expect(body.alertsEnabled).toBe(true);
    expect(body.alertsPausedUntil).toBe("2026-11-05T14:04:00.000Z");
  });
});
