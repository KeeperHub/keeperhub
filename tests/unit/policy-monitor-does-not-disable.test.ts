import { describe, expect, it } from "vitest";
import {
  Capability,
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  PolicyEnforcementMode,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";
import { shouldBlock } from "@/lib/policy/evaluator";
import type {
  CompiledPolicySet,
  PolicyDocument,
  PolicyFacts,
  Principal,
} from "@/lib/policy/types";

/**
 * Adding a policy in monitor mode must not stop an enforcing one from biting.
 *
 * Every new policy starts in monitor mode, so this is the ordinary way a second
 * policy arrives: somebody drafts one to watch what it would do. If that turns
 * off the rules already in force, the safe way to experiment is the dangerous
 * one, and nothing says so.
 */
const ORG = "org_1";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

const principal: Principal = {
  kind: PrincipalKind.MEMBER,
  userId: "u_1",
  organizationId: ORG,
  role: PolicyRole.MEMBER,
};

function facts(capability: Capability): PolicyFacts {
  return {
    capability,
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
  } as unknown as PolicyFacts;
}

const enforcingDeny: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "No borrowing",
  enforcement: PolicyEnforcementMode.ENFORCE,
  manages: ["protocol.lending.**"],
  statements: [
    {
      sid: "no-borrow",
      effect: "deny",
      capability: ["protocol.lending.borrow"],
    },
  ],
} as unknown as PolicyDocument;

/** A draft somebody added to watch the same corner of the system. */
const monitoringDraft: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Lending draft",
  enforcement: PolicyEnforcementMode.MONITOR,
  manages: ["protocol.lending.**"],
  statements: [
    {
      sid: "allow-supply",
      effect: "allow",
      capability: ["protocol.lending.supply"],
    },
  ],
} as unknown as PolicyDocument;

function compiled(doc: PolicyDocument, id: string) {
  const out = compilePolicy({
    id,
    enabled: true,
    document: doc,
    enforcement: doc.enforcement,
  });
  if (!out.ok) {
    throw new Error(out.errors.map((e) => e.message).join("; "));
  }
  return out.compiled;
}

function setOf(...docs: [PolicyDocument, string][]): CompiledPolicySet {
  return {
    organizationId: ORG,
    version: "v1",
    policies: docs.map(([doc, id]) => compiled(doc, id)),
    compiledAt: Date.now(),
  };
}

const borrow = () => ({
  principal,
  organizationId: ORG,
  capability: Capability.PROTOCOL_LENDING_BORROW,
  facts: facts(Capability.PROTOCOL_LENDING_BORROW),
  checkpoint: PolicyCheckpoint.NODE,
});

describe("a monitoring policy beside an enforcing one", () => {
  it("still refuses what the enforcing policy refuses", () => {
    const decision = evaluatePolicy(
      borrow(),
      setOf([enforcingDeny, "pol_enforce"], [monitoringDraft, "pol_monitor"])
    );

    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    // The deny came from the enforcing policy, so it has to bite. Treating the
    // whole decision as observational because some other policy is watching
    // turns drafting a policy into switching enforcement off.
    expect(shouldBlock(decision)).toBe(true);
  });

  it("blocks on its own", () => {
    const decision = evaluatePolicy(borrow(), setOf([enforcingDeny, "pol_1"]));
    expect(shouldBlock(decision)).toBe(true);
  });

  it("does not block when every governing policy is only watching", () => {
    const watching: PolicyDocument = {
      ...enforcingDeny,
      enforcement: PolicyEnforcementMode.MONITOR,
    } as PolicyDocument;

    const decision = evaluatePolicy(
      borrow(),
      setOf([watching, "pol_1"], [monitoringDraft, "pol_2"])
    );

    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(shouldBlock(decision)).toBe(false);
  });
});
