import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Capability,
  type CompiledPolicySet,
  enforceControlPlanePolicy,
  evaluateNodePolicy,
  FactState,
  isPolicyDeniedError,
  PolicyDecisionReason,
  PolicyDeniedError,
  type PolicyEvaluator,
  type PolicyFacts,
  PolicyOutcome,
  PolicyRole,
  type Principal,
  PrincipalKind,
  resetPolicyEvaluator,
  satisfiesRoleFloor,
  setPolicyEvaluator,
  shouldBlock,
  toPolicyDenial,
  unmanagedDecision,
  withNodePolicy,
} from "@/lib/policy";

const ORG = "org_1";

const member: Principal = {
  kind: PrincipalKind.MEMBER,
  userId: "user_1",
  organizationId: ORG,
  role: PolicyRole.MEMBER,
};

const agentKey: Principal = {
  kind: PrincipalKind.API_KEY,
  apiKeyId: "key_1",
  organizationId: ORG,
  role: PolicyRole.MEMBER,
};

function facts(capability: Capability): PolicyFacts {
  const unknown = { state: FactState.UNKNOWN } as const;
  return {
    capability,
    resource: unknown,
    chainId: unknown,
    contractAddress: unknown,
    selector: unknown,
    protocolSlug: unknown,
    assets: unknown,
    counterparties: unknown,
    nativeValueWei: unknown,
    usdValue: unknown,
    unbounded: unknown,
    gasPriceGwei: unknown,
    gasLimit: unknown,
    signerMode: unknown,
    triggerType: unknown,
    workflowId: unknown,
    workflowTags: unknown,
    projectId: unknown,
    sourceIp: unknown,
    httpHost: unknown,
    httpUrl: unknown,
    httpMethod: unknown,
    resourceId: unknown,
  };
}

function nodeContext(
  overrides: Partial<Parameters<typeof evaluateNodePolicy>[0]> = {}
) {
  return {
    principal: member,
    organizationId: ORG,
    capability: Capability.ASSET_TRANSFER_TOKEN,
    facts: facts(Capability.ASSET_TRANSFER_TOKEN),
    policySet: null as CompiledPolicySet | null,
    ...overrides,
  };
}

afterEach(() => {
  resetPolicyEvaluator();
});

describe("default evaluator", () => {
  it("treats every request as unmanaged while no policy exists", () => {
    const decision = evaluateNodePolicy(nodeContext());
    expect(decision.outcome).toBe(PolicyOutcome.UNMANAGED);
    expect(decision.reason).toBe(PolicyDecisionReason.UNMANAGED);
    expect(shouldBlock(decision)).toBe(false);
  });
});

describe("fail-closed behaviour", () => {
  it("denies when the organization cannot be determined", () => {
    const decision = evaluateNodePolicy(nodeContext({ organizationId: "" }));
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(decision.reason).toBe(PolicyDecisionReason.NO_PRINCIPAL);
    expect(shouldBlock(decision)).toBe(true);
  });

  it("denies when the evaluator itself throws", () => {
    // The single most important property in the engine: a bug inside the
    // policy check must never surface as permission.
    const exploding: PolicyEvaluator = {
      evaluate() {
        throw new TypeError("boom");
      },
    };
    setPolicyEvaluator(exploding);

    const decision = evaluateNodePolicy(nodeContext());
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(decision.reason).toBe(PolicyDecisionReason.ENGINE_ERROR);
    expect(shouldBlock(decision)).toBe(true);
  });

  it("blocks an engine failure even when the policy is observe-only", () => {
    const failing: PolicyEvaluator = {
      evaluate: () => ({
        ...unmanagedDecision(),
        outcome: PolicyOutcome.DENY,
        reason: PolicyDecisionReason.STORE_UNAVAILABLE,
        observedOnly: true,
      }),
    };
    setPolicyEvaluator(failing);

    const decision = evaluateNodePolicy(nodeContext());
    // "We could not check" is not an observation, so monitor mode does not
    // downgrade it.
    expect(shouldBlock(decision)).toBe(true);
  });
});

describe("monitor mode", () => {
  it("records a denial without blocking", () => {
    const observing: PolicyEvaluator = {
      evaluate: () => ({
        ...unmanagedDecision(),
        outcome: PolicyOutcome.DENY,
        reason: PolicyDecisionReason.EXPLICIT_DENY,
        observedOnly: true,
      }),
    };
    setPolicyEvaluator(observing);

    const decision = evaluateNodePolicy(nodeContext());
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(shouldBlock(decision)).toBe(false);
  });
});

describe("withNodePolicy", () => {
  it("runs the node when permitted", async () => {
    const run = vi.fn().mockResolvedValue("done");
    const outcome = await withNodePolicy(nodeContext(), run);

    expect(outcome.allowed).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    if (outcome.allowed) {
      expect(outcome.result).toBe("done");
    }
  });

  it("does not run the node when denied, and returns a typed error", async () => {
    const denying: PolicyEvaluator = {
      evaluate: () => ({
        ...unmanagedDecision(),
        outcome: PolicyOutcome.DENY,
        reason: PolicyDecisionReason.EXPLICIT_DENY,
        matched: [
          { policyId: "pol_1", sid: "no-borrowing", effect: "deny" as const },
        ],
      }),
    };
    setPolicyEvaluator(denying);

    const run = vi.fn().mockResolvedValue("should not happen");
    const outcome = await withNodePolicy(nodeContext(), run);

    expect(outcome.allowed).toBe(false);
    expect(run).not.toHaveBeenCalled();
    if (!outcome.allowed) {
      expect(outcome.error).toBeInstanceOf(PolicyDeniedError);
      expect(outcome.error.sid).toBe("no-borrowing");
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.error.isEngineFailure()).toBe(false);
    }
  });

  it("lets a node's own failure propagate untouched", async () => {
    const boom = new Error("rpc timeout");
    const run = vi.fn().mockRejectedValue(boom);
    await expect(withNodePolicy(nodeContext(), run)).rejects.toBe(boom);
  });
});

describe("control plane", () => {
  it("refuses below the role floor before consulting policy", () => {
    const evaluator = vi.fn();
    setPolicyEvaluator({ evaluate: evaluator });

    const result = enforceControlPlanePolicy({
      principal: member,
      organizationId: ORG,
      capability: Capability.POLICY_UPDATE,
      facts: facts(Capability.POLICY_UPDATE),
      policySet: null,
      roleFloor: PolicyRole.OWNER,
    });

    expect(result.blocked).toBe(true);
    // Policy is never reached, which is what makes "policy can only subtract"
    // a property of control flow rather than a convention.
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("consults policy once the role floor is satisfied", () => {
    const owner: Principal = { ...member, role: PolicyRole.OWNER };
    const result = enforceControlPlanePolicy({
      principal: owner,
      organizationId: ORG,
      capability: Capability.POLICY_UPDATE,
      facts: facts(Capability.POLICY_UPDATE),
      policySet: null,
      roleFloor: PolicyRole.OWNER,
    });

    expect(result.blocked).toBe(false);
  });

  it("refuses a principal acting outside its own organization", () => {
    const result = enforceControlPlanePolicy({
      principal: agentKey,
      organizationId: "org_other",
      capability: Capability.WORKFLOW_CREATE,
      facts: facts(Capability.WORKFLOW_CREATE),
      policySet: null,
    });

    expect(result.blocked).toBe(true);
    expect(result.decision.reason).toBe(PolicyDecisionReason.NO_PRINCIPAL);
  });

  it("refuses a principal with no organization role", () => {
    const service: Principal = {
      kind: PrincipalKind.SERVICE,
      service: "scheduler",
    };
    const result = enforceControlPlanePolicy({
      principal: service,
      organizationId: ORG,
      capability: Capability.WORKFLOW_CREATE,
      facts: facts(Capability.WORKFLOW_CREATE),
      policySet: null,
      roleFloor: PolicyRole.MEMBER,
    });

    expect(result.blocked).toBe(true);
  });
});

describe("satisfiesRoleFloor", () => {
  it("ranks member below admin below owner", () => {
    expect(satisfiesRoleFloor(PolicyRole.OWNER, PolicyRole.ADMIN)).toBe(true);
    expect(satisfiesRoleFloor(PolicyRole.ADMIN, PolicyRole.ADMIN)).toBe(true);
    expect(satisfiesRoleFloor(PolicyRole.MEMBER, PolicyRole.ADMIN)).toBe(false);
  });

  it("passes everything when there is no floor", () => {
    expect(satisfiesRoleFloor(null, "none")).toBe(true);
  });

  it("fails closed on a missing or unrecognised role", () => {
    expect(satisfiesRoleFloor(null, PolicyRole.MEMBER)).toBe(false);
    expect(
      satisfiesRoleFloor("superuser" as PolicyRole, PolicyRole.MEMBER)
    ).toBe(false);
  });
});

describe("toPolicyDenial", () => {
  it("converts an arbitrary throw into an engine-error denial", () => {
    const denial = toPolicyDenial(new RangeError("nope"));
    expect(isPolicyDeniedError(denial)).toBe(true);
    expect(denial.reason).toBe(PolicyDecisionReason.ENGINE_ERROR);
    expect(denial.isEngineFailure()).toBe(true);
  });

  it("passes an existing denial through unchanged", () => {
    const original = new PolicyDeniedError({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      sid: "s1",
    });
    expect(toPolicyDenial(original)).toBe(original);
  });

  it("never leaks internals in the user-facing message", () => {
    const denial = new PolicyDeniedError({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      sid: "secret-statement-id",
      policyId: "pol_secret",
    });
    expect(denial.toUserMessage()).not.toContain("secret-statement-id");
    expect(denial.toUserMessage()).not.toContain("pol_secret");
  });
});
