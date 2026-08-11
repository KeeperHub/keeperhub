import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const getOrgSubscription = vi.fn();
vi.mock("@/lib/billing/plans-server", () => ({
  getOrgSubscription: (...a: unknown[]) => getOrgSubscription(...a),
}));

const countMonthlyExecutionsForAdmission = vi.fn();
vi.mock("@/lib/billing/execution-limit-core", () => ({
  countMonthlyExecutionsForAdmission: (...a: unknown[]) =>
    countMonthlyExecutionsForAdmission(...a),
}));

const autopayForExecution = vi.fn();
vi.mock("@/lib/billing/payg/autopay", () => ({
  autopayForExecution: (...a: unknown[]) => autopayForExecution(...a),
}));

import { chargePaygIfBillable } from "@/lib/billing/payg/charge";

const PARAMS = { organizationId: "org_1", executionId: "exec_1" };
const FREE_LIMIT = 5000;

const originalFlag = process.env.NEXT_PUBLIC_BILLING_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  getOrgSubscription.mockResolvedValue({ plan: "free", tier: null });
  countMonthlyExecutionsForAdmission.mockResolvedValue(FREE_LIMIT + 1);
  autopayForExecution.mockResolvedValue({ ok: true, txHash: "0xtx" });
});

afterEach(() => {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = originalFlag;
});

describe("chargePaygIfBillable gating", () => {
  it("charges a free org that is past its included executions", async () => {
    const result = await chargePaygIfBillable(PARAMS);

    expect(autopayForExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ applicable: true, ok: true, txHash: "0xtx" });
  });

  // With billing off there is no UI to read or set spend caps, so no money may
  // move. The run is unbilled rather than blocked.
  it("never charges when billing is disabled", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const result = await chargePaygIfBillable(PARAMS);

    expect(autopayForExecution).not.toHaveBeenCalled();
    expect(getOrgSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({ applicable: false });
  });

  it("does not charge a paid plan", async () => {
    getOrgSubscription.mockResolvedValue({ plan: "pro", tier: "25k" });

    const result = await chargePaygIfBillable(PARAMS);

    expect(autopayForExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ applicable: false });
  });

  it("does not charge inside the included free bucket", async () => {
    countMonthlyExecutionsForAdmission.mockResolvedValue(FREE_LIMIT - 1);

    const result = await chargePaygIfBillable(PARAMS);

    expect(autopayForExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ applicable: false });
  });
});
