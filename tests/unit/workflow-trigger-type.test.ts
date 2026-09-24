import { describe, expect, it } from "vitest";
import { detectTriggerType } from "@/lib/metrics/instrumentation/workflow";
import {
  Capability,
  FactProvenance,
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  type PolicyDocument,
  PolicyEnforcementMode,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";
import { triggerTypeOf } from "@/lib/workflow/trigger-type";

const trigger = (triggerType?: unknown) => [
  {
    data: {
      type: "trigger",
      config: triggerType === undefined ? {} : { triggerType },
    },
  },
  { data: { type: "action", config: { actionType: "web3/read-contract" } } },
];

describe("triggerTypeOf", () => {
  it.each([
    ["Manual", "manual"],
    ["Webhook", "webhook"],
    ["Schedule", "scheduled"],
    ["Scheduled", "scheduled"],
    ["Event", "event"],
    ["Block", "block"],
    ["Transfer", "transfer"],
  ])("reads %s as %s", (declared, expected) => {
    expect(triggerTypeOf(trigger(declared))).toBe(expected);
  });

  it("reads the lower-case spelling older rows carry", () => {
    expect(triggerTypeOf(trigger("manual"))).toBe("manual");
  });

  it("tells nothing about a trigger it does not recognise", () => {
    // The bug this replaces: every one of these reported itself as manual, so
    // a rule permitting only manual runs permitted them.
    expect(triggerTypeOf(trigger("Tempo Payment Received"))).toBeUndefined();
    expect(triggerTypeOf(trigger("SomethingAddedLater"))).toBeUndefined();
  });

  it("tells nothing when the trigger declares no type", () => {
    expect(triggerTypeOf(trigger())).toBeUndefined();
  });

  it("tells nothing when there is no trigger node", () => {
    expect(
      triggerTypeOf([{ data: { type: "action", config: {} } }])
    ).toBeUndefined();
  });
});

describe("detectTriggerType", () => {
  it("names the triggers the old mapper flattened", () => {
    expect(detectTriggerType(trigger("Block"))).toBe("block");
    expect(detectTriggerType(trigger("Event"))).toBe("event");
    expect(detectTriggerType(trigger("Transfer"))).toBe("transfer");
  });

  it("keeps a label for a trigger nothing recognises", () => {
    expect(detectTriggerType(trigger("SomethingAddedLater"))).toBe("manual");
  });
});

/**
 * The chain the fix exists for: the workflow's own nodes decide the trigger
 * fact, and the trigger fact decides whether a rule scoped to manual runs
 * permits the node.
 */
describe("a rule scoped to manual runs", () => {
  const ORG = "org_1";
  const unknownFact = { state: FactState.UNKNOWN } as const;

  const manualOnly: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Reads only on manual runs",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages: ["contract.read"],
    statements: [
      {
        sid: "manual-runs-only",
        effect: "allow",
        capability: ["contract.read"],
        condition: { triggerType: { eq: "manual" } },
      },
    ],
  };

  function outcomeFor(declared: string): PolicyOutcome {
    const resolved = triggerTypeOf(trigger(declared));
    const compiled = compilePolicy({
      id: "pol_1",
      enabled: true,
      document: manualOnly,
    });
    if (!compiled.ok) {
      throw new Error("policy did not compile");
    }
    return evaluatePolicy(
      {
        principal: {
          kind: PrincipalKind.MEMBER,
          userId: "u1",
          organizationId: ORG,
          role: PolicyRole.MEMBER,
        },
        organizationId: ORG,
        capability: Capability.CONTRACT_READ,
        checkpoint: PolicyCheckpoint.NODE,
        facts: {
          capability: Capability.CONTRACT_READ,
          resource: unknownFact,
          chainId: unknownFact,
          contractAddress: unknownFact,
          selector: unknownFact,
          protocolSlug: unknownFact,
          assets: unknownFact,
          counterparties: unknownFact,
          nativeValueWei: unknownFact,
          usdValue: unknownFact,
          unbounded: unknownFact,
          gasPriceGwei: unknownFact,
          gasLimit: unknownFact,
          signerMode: unknownFact,
          triggerType: resolved
            ? {
                state: FactState.KNOWN,
                value: resolved,
                provenance: FactProvenance.AUTHORITATIVE,
              }
            : unknownFact,
          workflowId: unknownFact,
          workflowTags: unknownFact,
          projectId: unknownFact,
          sourceIp: unknownFact,
          httpHost: unknownFact,
          httpUrl: unknownFact,
          httpMethod: unknownFact,
          resourceId: unknownFact,
        },
      },
      {
        organizationId: ORG,
        version: "v1",
        policies: [compiled.compiled],
        compiledAt: 0,
      }
    ).outcome;
  }

  it("permits the run a person started", () => {
    expect(outcomeFor("Manual")).toBe(PolicyOutcome.ALLOW);
  });

  it.each(["Block", "Transfer", "Schedule", "Webhook", "Event"])(
    "refuses a %s run, which used to read as manual",
    (declared) => {
      expect(outcomeFor(declared)).toBe(PolicyOutcome.DENY);
    }
  );

  it("refuses a trigger nothing recognises rather than assuming a person", () => {
    expect(outcomeFor("SomethingAddedLater")).toBe(PolicyOutcome.DENY);
  });
});
