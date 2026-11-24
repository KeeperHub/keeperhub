import { describe, expect, it } from "vitest";
import {
  Capability,
  PolicyCheckpoint as Checkpoint,
  type CompiledPolicySet,
  FactProvenance,
  FactState,
  POLICY_SCHEMA_VERSION,
  type PolicyCheckpoint,
  PolicyDecisionReason,
  type PolicyDocument,
  PolicyEnforcementMode,
  type PolicyFacts,
  PolicyOutcome,
  PolicyRole,
  type Principal,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";

const ORG = "org_1";
const AAVE_POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const SUPPLY = "0x617ba037";

const principal: Principal = {
  kind: PrincipalKind.MEMBER,
  userId: "u1",
  organizationId: ORG,
  role: PolicyRole.MEMBER,
};

const unknown = { state: FactState.UNKNOWN } as const;

function known<T>(
  value: T,
  provenance: FactProvenance = FactProvenance.AUTHORITATIVE
) {
  return { state: FactState.KNOWN, value, provenance } as const;
}

function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    capability: Capability.PROTOCOL_LENDING_SUPPLY,
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
    ...overrides,
  };
}

function request(
  capability: Capability,
  f: Partial<PolicyFacts> = {},
  checkpoint: PolicyCheckpoint = Checkpoint.NODE
) {
  return {
    principal,
    organizationId: ORG,
    capability,
    facts: facts({ capability, ...f }),
    checkpoint,
  };
}

function policySet(doc: PolicyDocument, id = "pol_1"): CompiledPolicySet {
  const out = compilePolicy({ id, enabled: true, document: doc });
  if (!out.ok) {
    throw new Error(
      `compile failed: ${out.errors.map((e) => e.message).join("; ")}`
    );
  }
  return {
    organizationId: ORG,
    version: "v1",
    policies: [out.compiled],
    compiledAt: Date.now(),
  };
}

const lendingPolicy: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Lending bounds",
  enforcement: PolicyEnforcementMode.ENFORCE,
  manages: ["protocol.lending.**"],
  statements: [
    {
      sid: "allow-supply",
      effect: "allow",
      capability: ["protocol.lending.supply"],
      condition: { usdValue: { lte: "150000" } },
    },
    {
      sid: "no-borrow",
      effect: "deny",
      capability: ["protocol.lending.borrow"],
    },
  ],
};

describe("unmanaged", () => {
  it("allows a capability no policy claims", () => {
    const d = evaluatePolicy(
      request(Capability.ASSET_TRANSFER_TOKEN),
      policySet(lendingPolicy)
    );
    expect(d.outcome).toBe(PolicyOutcome.UNMANAGED);
    expect(d.reason).toBe(PolicyDecisionReason.UNMANAGED);
  });

  it("allows everything when there is no policy set at all", () => {
    const d = evaluatePolicy(request(Capability.PROTOCOL_LENDING_BORROW), null);
    expect(d.outcome).toBe(PolicyOutcome.UNMANAGED);
  });
});

describe("the allowlist default inside a managed scope", () => {
  it("allows a capability an allow statement covers", () => {
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_SUPPLY, {
        usdValue: known("100000"),
      }),
      policySet(lendingPolicy)
    );
    expect(d.outcome).toBe(PolicyOutcome.ALLOW);
    expect(d.matched[0]?.sid).toBe("allow-supply");
  });

  it("denies a managed capability that no allow covers", () => {
    // withdraw is inside protocol.lending.** but no statement permits it.
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_WITHDRAW),
      policySet(lendingPolicy)
    );
    expect(d.outcome).toBe(PolicyOutcome.DENY);
    expect(d.reason).toBe(PolicyDecisionReason.NO_MATCHING_ALLOW);
  });

  it("denies on an explicit deny even where an allow also matches", () => {
    const both: PolicyDocument = {
      ...lendingPolicy,
      statements: [
        {
          sid: "allow-all-lending",
          effect: "allow",
          capability: ["protocol.lending.**"],
        },
        {
          sid: "no-borrow",
          effect: "deny",
          capability: ["protocol.lending.borrow"],
        },
      ],
    };
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_BORROW),
      policySet(both)
    );
    expect(d.outcome).toBe(PolicyOutcome.DENY);
    expect(d.reason).toBe(PolicyDecisionReason.EXPLICIT_DENY);
  });
});

describe("fail-closed on unknown facts", () => {
  it("does not allow when a condition cannot be determined", () => {
    // usdValue is unknown, so the allow cannot match and nothing else permits.
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_SUPPLY),
      policySet(lendingPolicy)
    );
    expect(d.outcome).toBe(PolicyOutcome.DENY);
  });

  it("denies when a deny condition cannot be determined", () => {
    const doc: PolicyDocument = {
      ...lendingPolicy,
      statements: [
        {
          sid: "allow-supply",
          effect: "allow",
          capability: ["protocol.lending.supply"],
        },
        {
          sid: "block-big",
          effect: "deny",
          capability: ["protocol.lending.supply"],
          condition: { usdValue: { gt: "1000000" } },
        },
      ],
    };
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_SUPPLY),
      policySet(doc)
    );
    // Cannot rule the deny out, so it applies.
    expect(d.outcome).toBe(PolicyOutcome.DENY);
    expect(d.reason).toBe(PolicyDecisionReason.EXPLICIT_DENY);
  });
});

describe("the provenance rule", () => {
  const doc: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Contract bounds",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages: ["contract.write"],
    statements: [
      {
        sid: "allow-pool",
        effect: "allow",
        capability: ["contract.write"],
        resource: [`kh:chain/8453/contract/${AAVE_POOL}/fn/${SUPPLY}`],
      },
    ],
  };
  const target = `kh:chain/8453/contract/${AAVE_POOL}/fn/${SUPPLY}`;

  it("allows when the resource is authoritative", () => {
    const d = evaluatePolicy(
      request(Capability.CONTRACT_WRITE, { resource: known(target) }),
      policySet(doc)
    );
    expect(d.outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses to allow on a workflow-derived resource", () => {
    // Same target, but it arrived through an upstream node's output. An
    // attacker controlling that output must not be able to grant themselves.
    const d = evaluatePolicy(
      request(Capability.CONTRACT_WRITE, {
        resource: known(target, FactProvenance.WORKFLOW_DERIVED),
      }),
      policySet(doc)
    );
    expect(d.outcome).toBe(PolicyOutcome.DENY);
  });

  it("still denies on a workflow-derived value the deny names", () => {
    const denyDoc: PolicyDocument = {
      ...doc,
      statements: [
        {
          sid: "allow-any",
          effect: "allow",
          capability: ["contract.write"],
        },
        {
          sid: "block-pool",
          effect: "deny",
          capability: ["contract.write"],
          resource: [target],
        },
      ],
    };
    const d = evaluatePolicy(
      request(Capability.CONTRACT_WRITE, {
        resource: known(target, FactProvenance.WORKFLOW_DERIVED),
      }),
      policySet(denyDoc)
    );
    // Provenance restricts granting, never refusing.
    expect(d.outcome).toBe(PolicyOutcome.DENY);
  });
});

describe("monitor mode", () => {
  it("still produces a deny, marked observed-only", () => {
    const d = evaluatePolicy(
      request(Capability.PROTOCOL_LENDING_BORROW),
      policySet({
        ...lendingPolicy,
        enforcement: PolicyEnforcementMode.MONITOR,
      })
    );
    expect(d.outcome).toBe(PolicyOutcome.DENY);
    expect(d.observedOnly).toBe(true);
  });
});

describe("composition across policies", () => {
  it("unions allows, so adding a policy can widen", () => {
    const a = compilePolicy({
      id: "pol_a",
      enabled: true,
      document: {
        schemaVersion: POLICY_SCHEMA_VERSION,
        name: "A",
        enforcement: PolicyEnforcementMode.ENFORCE,
        manages: ["protocol.lending.**"],
        statements: [
          {
            sid: "supply-only",
            effect: "allow",
            capability: ["protocol.lending.supply"],
          },
        ],
      },
    });
    const b = compilePolicy({
      id: "pol_b",
      enabled: true,
      document: {
        schemaVersion: POLICY_SCHEMA_VERSION,
        name: "B",
        enforcement: PolicyEnforcementMode.ENFORCE,
        manages: ["protocol.lending.**"],
        statements: [
          {
            sid: "withdraw-only",
            effect: "allow",
            capability: ["protocol.lending.withdraw"],
          },
        ],
      },
    });
    if (!(a.ok && b.ok)) {
      throw new Error("compile failed");
    }
    const set: CompiledPolicySet = {
      organizationId: ORG,
      version: "v1",
      policies: [a.compiled, b.compiled],
      compiledAt: Date.now(),
    };
    expect(
      evaluatePolicy(request(Capability.PROTOCOL_LENDING_WITHDRAW), set).outcome
    ).toBe(PolicyOutcome.ALLOW);
  });
});
