import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  logSystemWarn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const tail = { where: () => ({ limit: mocks.limit }) };
  return {
    db: {
      select: () => ({
        from: () => ({ ...tail, leftJoin: () => tail }),
      }),
    },
  };
});
vi.mock("@/lib/db/schema", () => ({
  organization: { id: {} },
  organizationSubscriptions: { organizationId: {} },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { BILLING: "BILLING" },
  logSystemWarn: mocks.logSystemWarn,
}));

import { resolveOrgPlan } from "@/lib/billing/subscription-read";

/** The organization row came back, carrying whatever subscription it has. */
function orgFound(subscription: Record<string, unknown> | null): void {
  mocks.limit.mockResolvedValue([{ orgId: "org_1", subscription }]);
}

beforeEach(() => {
  mocks.limit.mockReset();
  mocks.logSystemWarn.mockReset();
});

describe("resolveOrgPlan", () => {
  it("resolves an org with no subscription to free", async () => {
    orgFound(null);

    await expect(resolveOrgPlan("org_1")).resolves.toEqual({
      plan: "free",
      tier: null,
      planOverrides: null,
      status: null,
    });
    expect(mocks.logSystemWarn).not.toHaveBeenCalled();
  });

  it("resolves a stored plan and tier", async () => {
    orgFound({
      plan: "business",
      tier: "1m",
      status: "active",
      planOverrides: null,
    });

    await expect(resolveOrgPlan("org_1")).resolves.toEqual({
      plan: "business",
      tier: "1m",
      planOverrides: null,
      status: "active",
    });
  });

  it("refuses to call an unreadable org free", async () => {
    mocks.limit.mockResolvedValue([]);

    await expect(resolveOrgPlan("org_1")).resolves.toBeNull();
    expect(mocks.logSystemWarn).toHaveBeenCalledWith(
      "BILLING",
      expect.stringContaining("did not resolve"),
      undefined,
      expect.objectContaining({ organization_id: "org_1" })
    );
  });

  it("refuses a stored plan it does not model", async () => {
    orgFound({ plan: "legacy_gold", tier: null, status: "active" });

    await expect(resolveOrgPlan("org_1")).resolves.toBeNull();
    expect(mocks.logSystemWarn).toHaveBeenCalledWith(
      "BILLING",
      expect.stringContaining("not a plan we model"),
      undefined,
      expect.objectContaining({ stored_plan: "legacy_gold" })
    );
  });

  it("refuses a stored tier it does not model rather than using the base allowance", async () => {
    orgFound({ plan: "business", tier: "2m", status: "active" });

    await expect(resolveOrgPlan("org_1")).resolves.toBeNull();
    expect(mocks.logSystemWarn).toHaveBeenCalledWith(
      "BILLING",
      expect.stringContaining("not a tier we model"),
      undefined,
      expect.objectContaining({ stored_tier: "2m" })
    );
  });

  it("treats an absent tier as the plan's base allowance", async () => {
    orgFound({ plan: "business", status: "active" });

    await expect(resolveOrgPlan("org_1")).resolves.toMatchObject({
      plan: "business",
      tier: null,
    });
    expect(mocks.logSystemWarn).not.toHaveBeenCalled();
  });
});
