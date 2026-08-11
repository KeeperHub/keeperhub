import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: vi.fn(),
}));

vi.mock("@/lib/billing/plans-server", () => ({
  checkExecutionLimit: vi.fn(),
}));

import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import type {
  ExecutionLimitExceeded,
  ExecutionOverageAllowed,
  ExecutionWithinLimits,
} from "@/lib/billing/plans-server";
import { checkExecutionLimit } from "@/lib/billing/plans-server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enforceExecutionLimit", () => {
  it("passes when billing is disabled", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);

    const result = await enforceExecutionLimit("org_1");

    expect(result.blocked).toBe(false);
    expect(checkExecutionLimit).not.toHaveBeenCalled();
  });

  it("passes when organizationId is null", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);

    const result = await enforceExecutionLimit(null);

    expect(result.blocked).toBe(false);
    expect(checkExecutionLimit).not.toHaveBeenCalled();
  });

  it("passes when organizationId is undefined", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);

    const result = await enforceExecutionLimit(undefined);

    expect(result.blocked).toBe(false);
    expect(checkExecutionLimit).not.toHaveBeenCalled();
  });

  it("passes when within limits", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    const withinLimits: ExecutionWithinLimits = {
      allowed: true,
      isOverage: false,
      debtExecutions: 0,
      effectiveLimit: 25_000,
    };
    vi.mocked(checkExecutionLimit).mockResolvedValue(withinLimits);

    const result = await enforceExecutionLimit("org_1");

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.limitResult).toEqual(withinLimits);
    }
  });

  it("passes when overage is allowed (paid plan over limit)", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    const overageAllowed: ExecutionOverageAllowed = {
      allowed: true,
      isOverage: true,
      limit: 25_000,
      used: 30_000,
      overageRate: 2,
      debtExecutions: 0,
      effectiveLimit: 25_000,
    };
    vi.mocked(checkExecutionLimit).mockResolvedValue(overageAllowed);

    const result = await enforceExecutionLimit("org_1");

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.limitResult).toEqual(overageAllowed);
    }
  });

  it("blocks when free plan limit exceeded", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    const exceeded: ExecutionLimitExceeded = {
      allowed: false,
      limit: 5000,
      used: 5000,
      plan: "free",
      debtExecutions: 0,
      effectiveLimit: 5000,
    };
    vi.mocked(checkExecutionLimit).mockResolvedValue(exceeded);

    const result = await enforceExecutionLimit("org_1");

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.response.status).toBe(429);
      const body = await result.response.json();
      expect(body.error).toBe("Monthly execution limit exceeded");
      expect(body.limit).toBe(5000);
      expect(body.used).toBe(5000);
      expect(body.plan).toBe("free");
    }
  });
});
