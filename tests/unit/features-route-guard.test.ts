import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: vi.fn(),
}));

vi.mock("@/lib/billing/plans-server", () => ({
  getOrgPlan: vi.fn(),
}));

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getOrgPlan } from "@/lib/billing/plans-server";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";

const databaseQueryNode = {
  id: "node-db-1",
  actionType: "Database Query",
};

const conditionNode = {
  id: "node-cond-1",
  actionType: "Condition",
};

// A plugin action with no explicit feature entry, gated only by its
// "user-destination" egress classification (the catch-all external-request
// gate). Exercises the egress-derived path, not the static actionTypes map.
const blockscoutNode = {
  id: "node-bs-1",
  actionType: "blockscout/get-address-balance",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enforceWorkflowFeatures", () => {
  it("passes when billing is disabled regardless of nodes", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);

    const result = await enforceWorkflowFeatures([databaseQueryNode], "org_1");

    expect(result.blocked).toBe(false);
    expect(getOrgPlan).not.toHaveBeenCalled();
  });

  it("passes when no nodes are gated, even on free plan", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");

    const result = await enforceWorkflowFeatures([conditionNode], "org_1");

    expect(result.blocked).toBe(false);
  });

  it("passes when org plan satisfies the feature requirement", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("pro");

    const result = await enforceWorkflowFeatures([databaseQueryNode], "org_1");

    expect(result.blocked).toBe(false);
  });

  it("blocks with HTTP 402 when free plan hits a gated node", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");

    const result = await enforceWorkflowFeatures([databaseQueryNode], "org_1");

    expect(result.blocked).toBe(true);
    if (!result.blocked) {
      return;
    }
    expect(result.response.status).toBe(402);
    const body = await result.response.json();
    expect(body.code).toBe("upgrade_required");
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].featureId).toBe("action.database-query");
    expect(body.violations[0].requiredPlan).toBe("pro");
    expect(body.violations[0].nodeIds).toEqual(["node-db-1"]);
  });

  it("blocks a user-destination plugin action (blockscout) on the free plan via the egress gate", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");

    const result = await enforceWorkflowFeatures([blockscoutNode], "org_1");

    expect(result.blocked).toBe(true);
    if (!result.blocked) {
      return;
    }
    expect(result.response.status).toBe(402);
    const body = await result.response.json();
    expect(body.code).toBe("upgrade_required");
    expect(body.violations[0].featureId).toBe("action.external-request");
    expect(body.violations[0].requiredPlan).toBe("pro");
    expect(body.violations[0].nodeIds).toEqual(["node-bs-1"]);
  });

  it("allows the user-destination action on a paid plan", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("pro");

    const result = await enforceWorkflowFeatures([blockscoutNode], "org_1");

    expect(result.blocked).toBe(false);
  });

  it("default-denies when no org context is provided and a node is gated", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);

    const result = await enforceWorkflowFeatures([databaseQueryNode], null);

    expect(result.blocked).toBe(true);
    expect(getOrgPlan).not.toHaveBeenCalled();
  });

  it("default-allows when no org context is provided and no node is gated", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);

    const result = await enforceWorkflowFeatures([conditionNode], undefined);

    expect(result.blocked).toBe(false);
    expect(getOrgPlan).not.toHaveBeenCalled();
  });

  it("uses the override error message when provided", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");

    const result = await enforceWorkflowFeatures([databaseQueryNode], "org_1", {
      errorMessage: "Custom upgrade copy for this route",
    });

    expect(result.blocked).toBe(true);
    if (!result.blocked) {
      return;
    }
    const body = await result.response.json();
    expect(body.error).toBe("Custom upgrade copy for this route");
    expect(body.code).toBe("upgrade_required");
  });

  it("falls back to the default error message when no override is given", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(getOrgPlan).mockResolvedValue("free");

    const result = await enforceWorkflowFeatures([databaseQueryNode], "org_1");

    expect(result.blocked).toBe(true);
    if (!result.blocked) {
      return;
    }
    const body = await result.response.json();
    expect(body.error).toBe(
      "This workflow uses features that require a paid plan."
    );
  });
});
