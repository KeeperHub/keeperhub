import { describe, expect, it } from "vitest";
import {
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";
import type {
  CompiledPolicySet,
  PolicyDocument,
  PolicyFacts,
  Principal,
} from "@/lib/policy/types";

const U = { state: FactState.UNKNOWN } as const;

function facts(capability: string): PolicyFacts {
  return {
    capability,
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
  } as PolicyFacts;
}

function compile(document: PolicyDocument): CompiledPolicySet {
  const outcome = compilePolicy({
    id: "candidate",
    enabled: true,
    document,
    enforcement: document.enforcement,
  });
  if (!outcome.ok) {
    throw new Error(outcome.errors.map((e) => e.message).join("; "));
  }
  return {
    organizationId: "o",
    version: "v",
    policies: [outcome.compiled],
    compiledAt: 0,
  };
}

function member(role: PolicyRole, userId: string): Principal {
  return { kind: PrincipalKind.MEMBER, userId, organizationId: "o", role };
}

function decide(
  set: CompiledPolicySet,
  principal: Principal,
  capability: string
) {
  return evaluatePolicy(
    {
      principal,
      organizationId: "o",
      capability: capability as never,
      facts: facts(capability),
      checkpoint: PolicyCheckpoint.CONTROL_PLANE,
    },
    set
  );
}

describe("a rule about who may act", () => {
  const byRole = compile({
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Only owners issue keys",
    enforcement: "enforce",
    acknowledgeSelfReferential: true,
    manages: ["apikey.**"],
    statements: [
      {
        sid: "owners-only",
        effect: "allow",
        capability: ["apikey.create"],
        condition: { actorRole: { eq: PolicyRole.OWNER } },
      },
    ],
  } as PolicyDocument);

  it("permits the owner", () => {
    expect(
      decide(byRole, member(PolicyRole.OWNER, "joel"), "apikey.create").outcome
    ).toBe(PolicyOutcome.ALLOW);
  });

  it.each([[PolicyRole.ADMIN], [PolicyRole.MEMBER]])("refuses %s", (role) => {
    expect(decide(byRole, member(role, "x"), "apikey.create").outcome).toBe(
      PolicyOutcome.DENY
    );
  });

  it("refuses a run with no role rather than treating it as a member", () => {
    expect(
      decide(
        byRole,
        { kind: PrincipalKind.SERVICE, service: "workflow-executor" },
        "apikey.create"
      ).outcome
    ).toBe(PolicyOutcome.DENY);
  });

  it("leaves an unclaimed capability alone", () => {
    expect(
      decide(byRole, member(PolicyRole.MEMBER, "x"), "workflow.create").outcome
    ).toBe(PolicyOutcome.UNMANAGED);
  });
});

describe("a rule naming one person", () => {
  const byPerson = compile({
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Only Ada removes members",
    enforcement: "enforce",
    // Removing a member can remove the person a policy constrains, so the
    // compiler makes the author say out loud that this is intended.
    acknowledgeSelfReferential: true,
    manages: ["member.**"],
    statements: [
      {
        sid: "ada-only",
        effect: "allow",
        capability: ["member.remove"],
        condition: { actorId: { in: ["seed-user-ada"] } },
      },
    ],
  } as PolicyDocument);

  it("permits the named person", () => {
    expect(
      decide(
        byPerson,
        member(PolicyRole.ADMIN, "seed-user-ada"),
        "member.remove"
      ).outcome
    ).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses everyone else, including the owner", () => {
    expect(
      decide(byPerson, member(PolicyRole.OWNER, "joel"), "member.remove")
        .outcome
    ).toBe(PolicyOutcome.DENY);
  });
});
