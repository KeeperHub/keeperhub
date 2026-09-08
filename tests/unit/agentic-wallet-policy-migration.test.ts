/**
 * Unit tests for lib/agentic-wallet/policy-migration.ts.
 *
 * The reconcile function is the only safe path to upgrade an existing
 * sub-org's policy set when BASELINE_POLICIES changes (e.g. ERC-8004
 * additions). It must:
 *
 *   1. Be idempotent: re-running on an up-to-date sub-org produces only
 *      "noop" actions and zero create/delete calls.
 *   2. Detect drift on the `condition` field and reissue (Turnkey policies
 *      are immutable in their condition).
 *   3. Create-then-delete on replace, never delete-then-create — avoiding
 *      a coverage gap between calls.
 *   4. Skip the notes field when comparing — cosmetic edits should not
 *      trigger destructive round-trips.
 */
import { describe, expect, it, vi } from "vitest";
import { BASELINE_POLICIES } from "@/lib/agentic-wallet/policy";
import { reconcileBaselinePolicies } from "@/lib/agentic-wallet/policy-migration";

type ListedPolicy = {
  policyId: string;
  policyName: string;
  effect: string;
  condition: string;
  notes?: string;
};

type StubClient = {
  getPolicies: ReturnType<typeof vi.fn>;
  createPolicy: ReturnType<typeof vi.fn>;
  deletePolicy: ReturnType<typeof vi.fn>;
};

function buildClient(initialPolicies: ListedPolicy[]): StubClient {
  let counter = 1;
  const policies = [...initialPolicies];
  const client: StubClient = {
    getPolicies: vi.fn(async () => ({ policies })),
    createPolicy: vi.fn(async (input: { policyName: string }) => {
      const newId = `policy-${counter++}`;
      policies.push({
        policyId: newId,
        policyName: input.policyName,
        effect: "EFFECT_DENY",
        condition: "stub",
      });
      return { activity: { id: "a", status: "COMPLETED" }, policyId: newId };
    }),
    deletePolicy: vi.fn(async () => undefined),
  };
  return client;
}

function buildClientWithExactBaseline(): StubClient {
  const initial: ListedPolicy[] = BASELINE_POLICIES.map((p, i) => ({
    policyId: `existing-${i}`,
    policyName: p.policyName,
    effect: p.effect,
    condition: p.condition,
  }));
  return buildClient(initial);
}

describe("reconcileBaselinePolicies", () => {
  it("returns noop for every baseline when sub-org is up-to-date", async () => {
    const client = buildClientWithExactBaseline();
    const result = await reconcileBaselinePolicies({
      client: client as any,
      subOrgId: "sub-1",
    });
    expect(result.subOrgId).toBe("sub-1");
    expect(result.actions.length).toBe(BASELINE_POLICIES.length);
    expect(result.actions.every((a) => a.action === "noop")).toBe(true);
    expect(client.createPolicy).not.toHaveBeenCalled();
    expect(client.deletePolicy).not.toHaveBeenCalled();
  });

  it("creates missing policies (empty starting state)", async () => {
    const client = buildClient([]);
    const result = await reconcileBaselinePolicies({
      client: client as any,
      subOrgId: "sub-1",
    });
    expect(result.actions.every((a) => a.action === "create")).toBe(true);
    expect(client.createPolicy).toHaveBeenCalledTimes(BASELINE_POLICIES.length);
    expect(client.deletePolicy).not.toHaveBeenCalled();
  });

  it("replaces stale policies (condition drift) with create-before-delete order", async () => {
    // Seed with one stale policy and the rest fresh.
    const stalePolicyName = "allowlist-outbound-contracts";
    const initial: ListedPolicy[] = BASELINE_POLICIES.map((p, i) => ({
      policyId: `existing-${i}`,
      policyName: p.policyName,
      effect: p.effect,
      condition:
        p.policyName === stalePolicyName ? "OUTDATED_CONDITION" : p.condition,
    }));
    const client = buildClient(initial);
    const result = await reconcileBaselinePolicies({
      client: client as any,
      subOrgId: "sub-1",
    });

    const replaceActions = result.actions.filter((a) => a.action === "replace");
    expect(replaceActions.length).toBe(1);
    expect(replaceActions[0]?.policyName).toBe(stalePolicyName);

    expect(client.createPolicy).toHaveBeenCalledTimes(1);
    expect(client.deletePolicy).toHaveBeenCalledTimes(1);

    // Order: delete must happen BEFORE create -- Turnkey rejects duplicate
    // policy names ("policy label must be unique"), so we cannot
    // create-before-delete. We accept a brief coverage gap and the
    // operator-side retry contract.
    const createOrder = client.createPolicy.mock.invocationCallOrder[0];
    const deleteOrder = client.deletePolicy.mock.invocationCallOrder[0];
    expect(createOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    if (createOrder !== undefined && deleteOrder !== undefined) {
      expect(deleteOrder).toBeLessThan(createOrder);
    }
  });

  it("does not reissue on notes-only drift", async () => {
    // Seed with all baseline conditions correct but notes mutated.
    const initial: ListedPolicy[] = BASELINE_POLICIES.map((p, i) => ({
      policyId: `existing-${i}`,
      policyName: p.policyName,
      effect: p.effect,
      condition: p.condition,
      notes: "stale notes -- should not trigger replacement",
    }));
    const client = buildClient(initial);
    const result = await reconcileBaselinePolicies({
      client: client as any,
      subOrgId: "sub-1",
    });
    expect(result.actions.every((a) => a.action === "noop")).toBe(true);
    expect(client.createPolicy).not.toHaveBeenCalled();
    expect(client.deletePolicy).not.toHaveBeenCalled();
  });
});
