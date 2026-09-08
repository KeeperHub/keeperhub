import { describe, expect, it } from "vitest";
import {
  Capability,
  FactProvenance,
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  type PolicyDocument,
  PolicyEnforcementMode,
  type PolicyFacts,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";

const ORG = "org_1";
const U = { state: FactState.UNKNOWN } as const;
const k = <T>(v: T) =>
  ({
    state: FactState.KNOWN,
    value: v,
    provenance: FactProvenance.AUTHORITATIVE,
  }) as const;

function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    capability: Capability.CONTRACT_READ,
    resource: U,
    chainId: U,
    contractAddress: U,
    selector: U,
    protocolSlug: U,
    assets: U,
    counterparties: U,
    nativeValueWei: U,
    usdValue: U,
    unbounded: U,
    gasPriceGwei: U,
    gasLimit: U,
    signerMode: U,
    triggerType: U,
    workflowId: U,
    workflowTags: U,
    projectId: U,
    sourceIp: U,
    httpHost: U,
    httpUrl: U,
    httpMethod: U,
    resourceId: U,
    ...overrides,
  } as PolicyFacts;
}

function decide(doc: PolicyDocument, f: Partial<PolicyFacts>): PolicyOutcome {
  const out = compilePolicy({ id: "pol_1", enabled: true, document: doc });
  if (!out.ok) {
    throw new Error(out.errors.map((e) => e.message).join("; "));
  }
  return evaluatePolicy(
    {
      principal: {
        kind: PrincipalKind.MEMBER,
        userId: "u",
        organizationId: ORG,
        role: PolicyRole.MEMBER,
      },
      organizationId: ORG,
      capability: Capability.CONTRACT_READ,
      facts: facts(f),
      checkpoint: PolicyCheckpoint.NODE,
    } as never,
    {
      organizationId: ORG,
      version: "v1",
      policies: [out.compiled],
      compiledAt: 0,
    }
  ).outcome;
}

const anyOfChain = (effect: "allow" | "deny"): PolicyDocument => ({
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Either chain",
  enforcement: PolicyEnforcementMode.ENFORCE,
  manages: ["contract.read"],
  statements: [
    {
      sid: "either-chain",
      effect,
      capability: ["contract.read"],
      condition: {
        anyOf: [{ chainId: { eq: 1 } }, { chainId: { eq: 8453 } }],
      },
    },
    ...(effect === "deny"
      ? [
          {
            sid: "otherwise-fine",
            effect: "allow" as const,
            capability: ["contract.read"],
          },
        ]
      : []),
  ],
});

describe("either-or inside one statement", () => {
  it("matches the first branch", () => {
    expect(decide(anyOfChain("allow"), { chainId: k(1) })).toBe(
      PolicyOutcome.ALLOW
    );
  });

  it("matches the second branch", () => {
    expect(decide(anyOfChain("allow"), { chainId: k(8453) })).toBe(
      PolicyOutcome.ALLOW
    );
  });

  it("matches neither, so the allow does not fire", () => {
    expect(decide(anyOfChain("allow"), { chainId: k(137) })).toBe(
      PolicyOutcome.DENY
    );
  });

  it("refuses on a deny when a branch matches", () => {
    expect(decide(anyOfChain("deny"), { chainId: k(1) })).toBe(
      PolicyOutcome.DENY
    );
  });

  it("permits on a deny when no branch matches", () => {
    expect(decide(anyOfChain("deny"), { chainId: k(137) })).toBe(
      PolicyOutcome.ALLOW
    );
  });
});

describe("what an undetermined fact does inside a group", () => {
  it("does not let an allow through on a fact nobody could establish", () => {
    // The fail-closed rule has to survive grouping. An allow needs a definite
    // yes, and an OR of undetermined branches is not one.
    expect(decide(anyOfChain("allow"), {})).toBe(PolicyOutcome.DENY);
  });

  it("still refuses on a deny it cannot rule out", () => {
    expect(decide(anyOfChain("deny"), {})).toBe(PolicyOutcome.DENY);
  });

  it("takes a branch that definitely matches over one it cannot tell", () => {
    const doc: PolicyDocument = {
      schemaVersion: POLICY_SCHEMA_VERSION,
      name: "Known or unknown",
      enforcement: PolicyEnforcementMode.ENFORCE,
      manages: ["contract.read"],
      statements: [
        {
          sid: "either",
          effect: "allow",
          capability: ["contract.read"],
          condition: {
            anyOf: [{ usdValue: { lte: "10" } }, { chainId: { eq: 1 } }],
          },
        },
      ],
    };
    expect(decide(doc, { chainId: k(1) })).toBe(PolicyOutcome.ALLOW);
  });
});

describe("groups nest", () => {
  const doc: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Nested",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages: ["contract.read"],
    statements: [
      {
        sid: "nested",
        effect: "allow",
        capability: ["contract.read"],
        condition: {
          anyOf: [
            {
              allOf: [
                { chainId: { eq: 1 } },
                { triggerType: { eq: "manual" } },
              ],
            },
            { chainId: { eq: 8453 } },
          ],
        },
      },
    ],
  };

  it("permits when every part of the inner group holds", () => {
    expect(decide(doc, { chainId: k(1), triggerType: k("manual") })).toBe(
      PolicyOutcome.ALLOW
    );
  });

  it("refuses when only part of the inner group holds", () => {
    expect(decide(doc, { chainId: k(1), triggerType: k("webhook") })).toBe(
      PolicyOutcome.DENY
    );
  });

  it("permits through the other branch regardless of the inner group", () => {
    expect(decide(doc, { chainId: k(8453), triggerType: k("webhook") })).toBe(
      PolicyOutcome.ALLOW
    );
  });
});

describe("what the compiler refuses", () => {
  const withCondition = (condition: unknown): PolicyDocument => ({
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "x",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages: ["contract.read"],
    statements: [
      {
        sid: "s",
        effect: "allow",
        capability: ["contract.read"],
        condition: condition as never,
      },
    ],
  });

  const compile = (condition: unknown) =>
    compilePolicy({
      id: "p",
      enabled: true,
      document: withCondition(condition),
    });

  it("refuses a signal hidden inside a group on an allow", () => {
    // The monotonicity rule has to hold at any depth, or nesting becomes the
    // way around it.
    const out = compile({
      anyOf: [
        { chainId: { eq: 1 } },
        { "signal.contractUnknown": { eq: true } },
      ],
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.errors.map((e) => e.message).join(" ")).toContain(
      "signal"
    );
  });

  it("refuses an empty group, which could never match", () => {
    const out = compile({ anyOf: [] });
    expect(out.ok).toBe(false);
  });

  it("refuses a group that is not a list", () => {
    const out = compile({ anyOf: { chainId: { eq: 1 } } });
    expect(out.ok).toBe(false);
  });

  it("refuses an unknown condition key inside a group", () => {
    const out = compile({ anyOf: [{ notAFact: { eq: 1 } }] });
    expect(out.ok).toBe(false);
  });

  it("refuses nesting too deep to read", () => {
    let condition: unknown = { chainId: { eq: 1 } };
    for (let i = 0; i < 8; i++) {
      condition = { anyOf: [condition] };
    }
    expect(compile(condition).ok).toBe(false);
  });

  it("accepts a plain flat condition unchanged", () => {
    expect(compile({ chainId: { eq: 1 } }).ok).toBe(true);
  });
});
