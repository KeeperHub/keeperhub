import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The store is the only I/O the guard does, so stubbing it is enough to drive
// every branch without a database.
const getCompiledPolicySet = vi.fn();
const loadGrants = vi.fn();

vi.mock("@/lib/policy/store", () => ({
  getCompiledPolicySet: (...args: unknown[]) => getCompiledPolicySet(...args),
  loadGrants: (...args: unknown[]) => loadGrants(...args),
  grantCovers: (
    grants: { resource: string; capabilities: string[] }[],
    resource: string,
    capability: string
  ) =>
    grants.find(
      (g) => g.resource === resource && g.capabilities.includes(capability)
    ) ?? null,
}));

vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));

import {
  Capability,
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyDecisionReason,
  type PolicyFacts,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { enforcePolicy } from "@/lib/policy/guard";

const UNKNOWN = { state: FactState.UNKNOWN } as const;
const RESOURCE = "kh:chain/8453/contract/0xaaa/fn/0x11223344";

function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    capability: Capability.CONTRACT_WRITE,
    resource: UNKNOWN,
    chainId: UNKNOWN,
    contractAddress: UNKNOWN,
    selector: UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: UNKNOWN,
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: UNKNOWN,
    ...overrides,
  };
}

const principal = {
  kind: PrincipalKind.MEMBER,
  userId: "u1",
  organizationId: "org_1",
  role: PolicyRole.MEMBER,
} as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    principal,
    organizationId: "org_1",
    capability: Capability.CONTRACT_WRITE,
    facts: facts(),
    checkpoint: PolicyCheckpoint.NODE,
    ...overrides,
  } as Parameters<typeof enforcePolicy>[0];
}

const EMPTY_SET = {
  organizationId: "org_1",
  version: "v1",
  policies: [],
  compiledAt: Date.now(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("the guard fails closed", () => {
  it("denies when the organization is unknown", async () => {
    const verdict = await enforcePolicy(input({ organizationId: null }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.NO_PRINCIPAL);
  });

  it("denies when the policy store cannot be read", async () => {
    // Null is "could not read", never "no policies". Failing open here would
    // make a database blip a way around every guardrail in the product.
    getCompiledPolicySet.mockResolvedValue(null);
    const verdict = await enforcePolicy(input());
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(
      PolicyDecisionReason.STORE_UNAVAILABLE
    );
  });

  it("denies when the store throws outright", async () => {
    getCompiledPolicySet.mockRejectedValue(new Error("connection reset"));
    const verdict = await enforcePolicy(input());
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.ENGINE_ERROR);
  });

  it("denies when grant resolution throws", async () => {
    getCompiledPolicySet.mockResolvedValue(EMPTY_SET);
    loadGrants.mockRejectedValue(new TypeError("boom"));
    const verdict = await enforcePolicy(
      input({
        facts: facts({
          resource: {
            state: FactState.KNOWN,
            value: RESOURCE,
            provenance: FactProvenance.WORKFLOW_DERIVED,
          },
        }),
        grantSubject: { kind: "workflow", id: "wf_1" },
      })
    );
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.ENGINE_ERROR);
  });
});

describe("grant resolution", () => {
  it("refuses a resource no held grant covers", async () => {
    getCompiledPolicySet.mockResolvedValue(EMPTY_SET);
    loadGrants.mockResolvedValue([
      {
        id: "g1",
        resource: "kh:chain/1/contract/0xbbb/fn/*",
        capabilities: [],
      },
    ]);
    const verdict = await enforcePolicy(
      input({
        facts: facts({
          resource: {
            state: FactState.KNOWN,
            value: RESOURCE,
            provenance: FactProvenance.WORKFLOW_DERIVED,
          },
        }),
        grantSubject: { kind: "workflow", id: "wf_1" },
      })
    );
    expect(verdict.blocked).toBe(true);
    // Never given, as distinct from held and refused by a rule.
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.NOT_GRANTED);
  });

  it("does not refuse a subject that holds no grants at all", async () => {
    // A subject predating the grant layer reaches nothing under a strict
    // reading, which would deny every existing workflow. That gap is closed by
    // the backfill, not by denying here.
    getCompiledPolicySet.mockResolvedValue(EMPTY_SET);
    loadGrants.mockResolvedValue([]);
    const verdict = await enforcePolicy(
      input({
        facts: facts({
          resource: {
            state: FactState.KNOWN,
            value: RESOURCE,
            provenance: FactProvenance.WORKFLOW_DERIVED,
          },
        }),
        grantSubject: { kind: "workflow", id: "wf_1" },
      })
    );
    expect(verdict.blocked).toBe(false);
  });

  it("skips grant resolution when no subject is given", async () => {
    getCompiledPolicySet.mockResolvedValue(EMPTY_SET);
    const verdict = await enforcePolicy(input());
    expect(verdict.blocked).toBe(false);
    expect(loadGrants).not.toHaveBeenCalled();
  });
});
