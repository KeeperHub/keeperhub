import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const isBillingEnabled = vi.fn(() => true);
vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: () => isBillingEnabled(),
}));

const getOrgPlan = vi.fn(async (..._args: unknown[]) => "free");
const checkExecutionLimit = vi.fn(
  async (..._args: unknown[]) =>
    ({ allowed: true }) as { allowed: boolean; isOverage?: boolean }
);
vi.mock("@/lib/billing/plans-server", () => ({
  getOrgPlan: (...args: unknown[]) => getOrgPlan(...args),
  checkExecutionLimit: (...args: unknown[]) => checkExecutionLimit(...args),
}));

const validateWorkflowFeatures = vi.fn(
  (..._args: unknown[]) => [] as { feature: { name: string } }[]
);
vi.mock("@/lib/features", () => ({
  extractActionTypeNodes: (nodes: unknown[]) => nodes,
  validateWorkflowFeatures: (...args: unknown[]) =>
    validateWorkflowFeatures(...args),
}));

import {
  __resetDispatchAdmissionCacheForTest,
  checkDispatchAdmission,
} from "@/lib/billing/dispatch-admission";

describe("checkDispatchAdmission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDispatchAdmissionCacheForTest();
    isBillingEnabled.mockReturnValue(true);
    getOrgPlan.mockResolvedValue("free");
    checkExecutionLimit.mockResolvedValue({ allowed: true });
    validateWorkflowFeatures.mockReturnValue([]);
  });

  it("admits when the org is within its limit and uses no gated feature", async () => {
    await expect(
      checkDispatchAdmission({ organizationId: "org_1", nodes: [] })
    ).resolves.toBeNull();
  });

  it("refuses a gated action before it costs a queue message", async () => {
    validateWorkflowFeatures.mockReturnValue([
      { feature: { name: "Custom ABI" } },
    ]);

    const refusal = await checkDispatchAdmission({
      organizationId: "org_1",
      nodes: [],
    });

    expect(refusal?.reason).toBe("plan_feature");
    expect(refusal?.message).toContain("Custom ABI");
  });

  // Which nodes are gated depends on the workflow, so the per-workflow half of
  // the decision must not be served from the org-level cache.
  it("re-validates features per workflow while reusing the org standing", async () => {
    await checkDispatchAdmission({ organizationId: "org_1", nodes: [] });
    validateWorkflowFeatures.mockReturnValue([
      { feature: { name: "Custom ABI" } },
    ]);

    const refusal = await checkDispatchAdmission({
      organizationId: "org_1",
      nodes: [{ id: "n1" }],
    });

    expect(refusal?.reason).toBe("plan_feature");
    expect(checkExecutionLimit).toHaveBeenCalledTimes(1);
  });

  // The admitted path is the common one; it must not pay a database read per
  // occurrence when a fast trigger fires repeatedly for the same org.
  it("reads the org standing once for repeated dispatches", async () => {
    await checkDispatchAdmission({ organizationId: "org_1", nodes: [] });
    await checkDispatchAdmission({ organizationId: "org_1", nodes: [] });
    await checkDispatchAdmission({ organizationId: "org_1", nodes: [] });

    expect(checkExecutionLimit).toHaveBeenCalledTimes(1);
    expect(getOrgPlan).toHaveBeenCalledTimes(1);
  });

  it("keeps the standing separate per org", async () => {
    checkExecutionLimit.mockResolvedValueOnce({ allowed: false });

    const refused = await checkDispatchAdmission({
      organizationId: "org_blocked",
      nodes: [],
    });
    const admitted = await checkDispatchAdmission({
      organizationId: "org_ok",
      nodes: [],
    });

    expect(refused?.reason).toBe("execution_limit");
    expect(admitted).toBeNull();
  });

  it("refuses when the execution limit check blocks the org", async () => {
    checkExecutionLimit.mockResolvedValue({ allowed: false });

    const refusal = await checkDispatchAdmission({
      organizationId: "org_1",
      nodes: [],
    });

    expect(refusal?.reason).toBe("execution_limit");
  });

  // Pay-as-you-go admits a free org past its included limit so the executor can
  // charge it after the claim. Refusing it here would drop paid-for runs.
  it("admits an org the limit check allows on overage or pay-as-you-go", async () => {
    checkExecutionLimit.mockResolvedValue({ allowed: true, isOverage: true });

    await expect(
      checkDispatchAdmission({ organizationId: "org_1", nodes: [] })
    ).resolves.toBeNull();
  });

  it("admits everything when billing is disabled", async () => {
    isBillingEnabled.mockReturnValue(false);
    validateWorkflowFeatures.mockReturnValue([
      { feature: { name: "Custom ABI" } },
    ]);

    await expect(
      checkDispatchAdmission({ organizationId: "org_1", nodes: [] })
    ).resolves.toBeNull();
  });

  // No org context means no plan we can read, so gated nodes are validated
  // against free rather than waved through.
  it("validates against the free plan when there is no org", async () => {
    validateWorkflowFeatures.mockReturnValue([
      { feature: { name: "Custom ABI" } },
    ]);

    const refusal = await checkDispatchAdmission({
      organizationId: null,
      nodes: [],
    });

    expect(refusal?.reason).toBe("plan_feature");
    expect(getOrgPlan).not.toHaveBeenCalled();
    expect(validateWorkflowFeatures).toHaveBeenCalledWith([], "free");
  });

  it("skips the limit check when there is no org to bill", async () => {
    const refusal = await checkDispatchAdmission({
      organizationId: null,
      nodes: [],
    });

    expect(refusal).toBeNull();
    expect(checkExecutionLimit).not.toHaveBeenCalled();
  });
});
