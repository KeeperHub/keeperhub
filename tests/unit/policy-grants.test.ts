import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getCompiledPolicySet = vi.fn();
const loadGrants = vi.fn();

vi.mock("@/lib/policy/store", () => ({
  getCompiledPolicySet: (...a: unknown[]) => getCompiledPolicySet(...a),
  loadGrants: (...a: unknown[]) => loadGrants(...a),
  grantCovers: (
    grants: { resource: string; capabilities: string[] }[],
    resource: string,
    capability: string
  ) =>
    grants.find(
      (g) =>
        g.capabilities.includes(capability) &&
        // The stored form ends in a deep wildcard, so a prefix match is what
        // the real matcher does for these.
        resource.startsWith(g.resource.replace(/\*\*$/, ""))
    ) ?? null,
}));
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));

const { enforcePolicy } = await import("@/lib/policy/guard");
const {
  Capability,
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} = await import("@/lib/policy");

const ORG = "org_1";
const GRANTED = "kh:chain/1/contract/0xaaaa/**";
const U = { state: FactState.UNKNOWN } as never;
const k = (v: unknown) =>
  ({
    state: FactState.KNOWN,
    value: v,
    provenance: FactProvenance.AUTHORITATIVE,
  }) as never;

function run(resource: string) {
  return enforcePolicy({
    principal: {
      kind: PrincipalKind.MEMBER,
      userId: "u",
      organizationId: ORG,
      role: PolicyRole.OWNER,
    },
    organizationId: ORG,
    capability: Capability.CONTRACT_READ,
    facts: {
      capability: Capability.CONTRACT_READ,
      resource: k(resource),
      chainId: k(1),
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
      triggerType: k("manual"),
      workflowId: k("wf_1"),
      workflowTags: U,
      projectId: U,
      sourceIp: U,
      httpHost: U,
      httpUrl: U,
      httpMethod: U,
      resourceId: U,
    } as never,
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: { kind: "workflow", id: "wf_1" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCompiledPolicySet.mockResolvedValue({
    organizationId: ORG,
    version: "v1",
    policies: [],
    compiledAt: 0,
  });
});

describe("what a workflow may reach", () => {
  it("permits a resource its grant covers", async () => {
    loadGrants.mockResolvedValue([
      { id: "g1", resource: GRANTED, capabilities: ["contract.read"] },
    ]);
    const v = await run("kh:chain/1/contract/0xaaaa/fn/0x18160ddd");
    expect(v.decision.outcome).toBe(PolicyOutcome.UNMANAGED);
  });

  it("refuses a resource no grant covers", async () => {
    loadGrants.mockResolvedValue([
      { id: "g1", resource: GRANTED, capabilities: ["contract.read"] },
    ]);
    const v = await run("kh:chain/1/contract/0xbbbb/fn/0x18160ddd");
    expect(v.blocked).toBe(true);
    expect(v.decision.reason).toBe("not_granted");
  });

  it("says the resource was never given, not that a rule refused it", async () => {
    loadGrants.mockResolvedValue([
      { id: "g1", resource: GRANTED, capabilities: ["contract.read"] },
    ]);
    const v = await run("kh:chain/1/contract/0xbbbb/fn/0x18160ddd");
    // The two denials need different answers: a missing grant is fixed by
    // issuing one, a policy refusal by editing a rule.
    expect(v.decision.message).toContain("has not been given access");
  });

  it("refuses when the grant names the resource but not the capability", async () => {
    loadGrants.mockResolvedValue([
      { id: "g1", resource: GRANTED, capabilities: ["contract.write"] },
    ]);
    const v = await run("kh:chain/1/contract/0xaaaa/fn/0x18160ddd");
    expect(v.decision.reason).toBe("not_granted");
  });

  it("leaves a subject holding no grants alone", async () => {
    // Every workflow predates this layer, so holding none means unconstrained
    // rather than reaching nothing. That is what makes issuing them gradual.
    loadGrants.mockResolvedValue([]);
    const v = await run("kh:chain/1/contract/0xbbbb/fn/0x18160ddd");
    expect(v.decision.outcome).toBe(PolicyOutcome.UNMANAGED);
  });
});
