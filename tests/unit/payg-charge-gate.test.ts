import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const autopayForExecution = vi.fn();
vi.mock("@/lib/billing/payg/autopay", () => ({
  autopayForExecution: (...a: unknown[]) => autopayForExecution(...a),
}));

import { chargePaygIfBillable } from "@/lib/billing/payg/charge";

const PARAMS = { organizationId: "org_1", executionId: "exec_1" };

const originalFlag = process.env.NEXT_PUBLIC_BILLING_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  autopayForExecution.mockResolvedValue({ ok: true, txHash: "0xtx" });
});

afterEach(() => {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = originalFlag;
});

describe("chargePaygIfBillable gating", () => {
  it("charges a free org that is past its included executions", async () => {
    const result = await chargePaygIfBillable({
      ...PARAMS,
      paygOverflow: true,
    });

    expect(autopayForExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ applicable: true, ok: true, txHash: "0xtx" });
  });

  // With billing off there is no UI to read or set spend caps, so no money may
  // move. The run is unbilled rather than blocked.
  it("never charges when billing is disabled", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const result = await chargePaygIfBillable({
      ...PARAMS,
      paygOverflow: true,
    });

    expect(autopayForExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ applicable: false });
  });

  // Paid plans and runs inside the free bucket both reach here with the verdict
  // the admission check already made, so neither is charged.
  it("does not charge a run the admission check admitted as included", async () => {
    const result = await chargePaygIfBillable({
      ...PARAMS,
      paygOverflow: false,
    });

    expect(autopayForExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ applicable: false });
  });
});
