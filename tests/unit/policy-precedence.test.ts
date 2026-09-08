import { describe, expect, it } from "vitest";
import {
  FactProvenance,
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
} from "@/lib/policy/types";

const CONTRACT = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const GOOD = "0x1111111111111111111111111111111111111111";
const BAD = "0x2222222222222222222222222222222222222222";
const SUPPLY = "0x617ba037";
const BORROW = "0xa415bcad";
const CHAIN = 8453;

const U = { state: FactState.UNKNOWN } as const;
const K = (value: unknown) => ({
  state: FactState.KNOWN,
  value,
  provenance: FactProvenance.AUTHORITATIVE,
});

function facts(counterparty: string, selector: string): PolicyFacts {
  return {
    capability: "contract.write",
    resource: K(`kh:chain/${CHAIN}/contract/${CONTRACT}/fn/${selector}`),
    chainId: K(CHAIN),
    contractAddress: K(CONTRACT),
    selector: K(selector),
    protocolSlug: U,
    assets: U,
    counterparties: K([{ address: counterparty, role: "recipient" }]),
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

const SCOPE = `kh:chain/${CHAIN}/contract/${CONTRACT}/**`;
const RESOURCE = `kh:chain/${CHAIN}/contract/${CONTRACT}/fn/*`;

function compile(...documents: PolicyDocument[]): CompiledPolicySet {
  return {
    organizationId: "o",
    version: "v",
    compiledAt: 0,
    policies: documents.map((document, index) => {
      const out = compilePolicy({
        id: `policy-${index}`,
        enabled: true,
        document,
        enforcement: "enforce",
      });
      if (!out.ok) {
        throw new Error(out.errors.map((e) => e.message).join("; "));
      }
      return out.compiled;
    }),
  };
}

function decide(
  set: CompiledPolicySet,
  counterparty: string,
  selector = SUPPLY
) {
  return evaluatePolicy(
    {
      principal: {
        kind: PrincipalKind.MEMBER,
        userId: "u",
        organizationId: "o",
        role: PolicyRole.OWNER,
      },
      organizationId: "o",
      capability: "contract.write" as never,
      facts: facts(counterparty, selector),
      checkpoint: PolicyCheckpoint.NODE,
    },
    set
  );
}

/** Allow everything here, except one address. */
const ALLOW_EXCEPT_BAD: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Allow, except one address",
  enforcement: "enforce",
  manages: [SCOPE],
  statements: [
    {
      sid: "allow-others",
      effect: "allow",
      capability: ["contract.write"],
      resource: [RESOURCE],
      condition: { counterparty: { notIn: [BAD] } },
    },
  ],
};

/** Refuse everything here, except one address. */
const DENY_EXCEPT_GOOD: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Deny, except one address",
  enforcement: "enforce",
  manages: [SCOPE],
  statements: [
    {
      sid: "deny-others",
      effect: "deny",
      capability: ["contract.write"],
      resource: [RESOURCE],
      condition: { counterparty: { notIn: [GOOD] } },
    },
    {
      sid: "allow-anything-in-scope",
      effect: "allow",
      capability: ["contract.write"],
      resource: [RESOURCE],
    },
  ],
};

/** A flat prohibition on one address, whatever else any policy says. */
const DENY_BAD: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Never this address",
  enforcement: "enforce",
  manages: [SCOPE],
  statements: [
    {
      sid: "never-bad",
      effect: "deny",
      capability: ["contract.write"],
      resource: [RESOURCE],
      condition: { counterparty: { in: [BAD] } },
    },
  ],
};

/** A separate policy that permits the same address. */
const ALLOW_BAD: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Permit that address",
  enforcement: "enforce",
  manages: [SCOPE],
  statements: [
    {
      sid: "allow-bad",
      effect: "allow",
      capability: ["contract.write"],
      resource: [RESOURCE],
      condition: { counterparty: { in: [BAD] } },
    },
  ],
};

describe("an exception on an allow", () => {
  const set = compile(ALLOW_EXCEPT_BAD);

  it("permits an address the exception does not name", () => {
    expect(decide(set, GOOD).outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses the excepted address, because nothing else permits it", () => {
    // The exception narrows the allow. It does not deny: the refusal comes from
    // the scope being claimed with nothing left permitting this call.
    const decision = decide(set, BAD);
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(decision.reason).toBe("no_matching_allow");
  });
});

describe("an exception on a deny", () => {
  const set = compile(DENY_EXCEPT_GOOD);

  it("permits the excepted address", () => {
    expect(decide(set, GOOD).outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses everything else", () => {
    const decision = decide(set, BAD);
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(decision.reason).toBe("explicit_deny");
  });
});

describe("a prohibition against a permission, across policies", () => {
  it("refuses, whichever order the policies are in", () => {
    // Deny is the only effect another policy cannot widen. A permission written
    // elsewhere, by someone else, later, cannot reopen an address a
    // prohibition closed.
    expect(decide(compile(DENY_BAD, ALLOW_BAD), BAD).outcome).toBe(
      PolicyOutcome.DENY
    );
    expect(decide(compile(ALLOW_BAD, DENY_BAD), BAD).outcome).toBe(
      PolicyOutcome.DENY
    );
  });

  it("names the prohibition as the reason", () => {
    const decision = decide(compile(DENY_BAD, ALLOW_BAD), BAD);
    expect(decision.reason).toBe("explicit_deny");
    expect(decision.matched.map((m) => m.sid)).toContain("never-bad");
  });

  it("leaves other addresses to the permission", () => {
    expect(decide(compile(DENY_BAD, ALLOW_EXCEPT_BAD), GOOD).outcome).toBe(
      PolicyOutcome.ALLOW
    );
  });
});

describe("carving one method out of a prohibition", () => {
  /**
   * A permission cannot reopen what a prohibition closed, so the carve-out has
   * to be written into the prohibition itself rather than added beside it.
   */
  const DENY_BAD_EXCEPT_SUPPLY: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Never this address, except one method",
    enforcement: "enforce",
    manages: [SCOPE],
    statements: [
      {
        sid: "never-bad-except-supply",
        effect: "deny",
        capability: ["contract.write"],
        resource: [RESOURCE],
        condition: {
          counterparty: { in: [BAD] },
          selector: { notIn: [SUPPLY] },
        },
      },
      {
        sid: "allow-in-scope",
        effect: "allow",
        capability: ["contract.write"],
        resource: [RESOURCE],
      },
    ],
  };

  const set = compile(DENY_BAD_EXCEPT_SUPPLY);

  it("permits the carved-out method", () => {
    expect(decide(set, BAD, SUPPLY).outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses every other method to that address", () => {
    expect(decide(set, BAD, BORROW).outcome).toBe(PolicyOutcome.DENY);
  });

  it("cannot be achieved by adding a permission beside the prohibition", () => {
    // The trap worth knowing: this reads like it should allow supply, and does
    // not, because deny wins.
    const beside = compile(DENY_BAD, {
      schemaVersion: POLICY_SCHEMA_VERSION,
      name: "But supply is fine",
      enforcement: "enforce",
      manages: [SCOPE],
      statements: [
        {
          sid: "supply-is-fine",
          effect: "allow",
          capability: ["contract.write"],
          resource: [`kh:chain/${CHAIN}/contract/${CONTRACT}/fn/${SUPPLY}`],
          condition: { counterparty: { in: [BAD] } },
        },
      ],
    });
    expect(decide(beside, BAD, SUPPLY).outcome).toBe(PolicyOutcome.DENY);
  });
});

describe("carving functions out of a rule", () => {
  /** Refuse the whole contract, except one function. */
  const DENY_EXCEPT_SUPPLY: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Refuse this contract, except supply",
    enforcement: "enforce",
    manages: [SCOPE],
    statements: [
      {
        sid: "deny-all-but-supply",
        effect: "deny",
        capability: ["contract.write"],
        resource: [RESOURCE],
        condition: { selector: { notIn: [SUPPLY] } },
      },
      {
        sid: "allow-in-scope",
        effect: "allow",
        capability: ["contract.write"],
        resource: [RESOURCE],
      },
    ],
  };

  const set = compile(DENY_EXCEPT_SUPPLY);

  it("permits the carved-out function", () => {
    expect(decide(set, GOOD, SUPPLY).outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses every other function on the contract", () => {
    const decision = decide(set, GOOD, BORROW);
    expect(decision.outcome).toBe(PolicyOutcome.DENY);
    expect(decision.reason).toBe("explicit_deny");
  });

  it("refuses regardless of who the counterparty is", () => {
    // The carve-out is about the function, so it does not quietly become a rule
    // about addresses.
    expect(decide(set, BAD, BORROW).outcome).toBe(PolicyOutcome.DENY);
    expect(decide(set, BAD, SUPPLY).outcome).toBe(PolicyOutcome.ALLOW);
  });
});

describe("a rule pinned to exact functions", () => {
  /**
   * The capability a request carries is read from the contract's catalog. Where
   * that cannot be reached the request carries the plain form instead, and a
   * rule listing only the semantic form would stop matching the very function
   * it names, without anything appearing to be wrong.
   */
  const PINNED: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Supply only, at this pool",
    enforcement: "enforce",
    manages: [SCOPE],
    statements: [
      {
        sid: "supply-here",
        effect: "allow",
        capability: ["protocol.lending.supply", "contract.write"],
        resource: [`kh:chain/${CHAIN}/contract/${CONTRACT}/fn/${SUPPLY}`],
      },
    ],
  };

  const set = compile(PINNED);

  function withCapability(capability: string, selector: string) {
    return evaluatePolicy(
      {
        principal: {
          kind: PrincipalKind.MEMBER,
          userId: "u",
          organizationId: "o",
          role: PolicyRole.OWNER,
        },
        organizationId: "o",
        capability: capability as never,
        facts: { ...facts(GOOD, selector), capability } as never,
        checkpoint: PolicyCheckpoint.NODE,
      },
      set
    );
  }

  it("matches when the catalog named the semantic capability", () => {
    expect(withCapability("protocol.lending.supply", SUPPLY).outcome).toBe(
      PolicyOutcome.ALLOW
    );
  });

  it("still matches when the catalog could not be read", () => {
    expect(withCapability("contract.write", SUPPLY).outcome).toBe(
      PolicyOutcome.ALLOW
    );
  });

  it("still refuses a function it does not name", () => {
    // Naming both verbs widens what the rule recognises, not what it reaches:
    // the resource is what says which function this is about.
    expect(withCapability("contract.write", BORROW).outcome).toBe(
      PolicyOutcome.DENY
    );
  });
});
