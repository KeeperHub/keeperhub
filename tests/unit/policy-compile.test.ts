import { describe, expect, it } from "vitest";
import {
  Capability,
  POLICY_SCHEMA_VERSION,
  type PolicyDocument,
  PolicyEnforcementMode,
  type PolicyStatement,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";

function doc(
  statements: PolicyStatement[],
  manages: string[] = ["protocol.lending.**"],
  extra: Partial<PolicyDocument> = {}
): PolicyDocument {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Test",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages,
    statements,
    ...extra,
  };
}

function compile(d: PolicyDocument) {
  return compilePolicy({ id: "pol_1", enabled: true, document: d });
}

function errorsOf(d: PolicyDocument): string[] {
  const out = compile(d);
  return out.ok ? [] : out.errors.map((e) => e.message);
}

describe("the monotonicity invariant", () => {
  it("rejects a signal used inside an allow", () => {
    const errs = errorsOf(
      doc([
        {
          sid: "s1",
          effect: "allow",
          capability: ["protocol.lending.supply"],
          condition: { "signal.riskScore": { lt: 0.5 } },
        },
      ])
    );
    expect(errs.join(" ")).toContain("signal");
    expect(errs.join(" ")).toContain("never grant");
  });

  it("permits the same signal inside a deny", () => {
    const out = compile(
      doc([
        {
          sid: "s1",
          effect: "allow",
          capability: ["protocol.lending.supply"],
        },
        {
          sid: "s2",
          effect: "deny",
          capability: ["protocol.lending.supply"],
          condition: { "signal.riskScore": { gt: 0.8 } },
        },
      ])
    );
    expect(out.ok).toBe(true);
  });

  it("permits a signal inside a deny", () => {
    const out = compile(
      doc([
        {
          sid: "s1",
          effect: "deny",
          capability: ["protocol.lending.supply"],
          condition: { "signal.contractUnknown": { eq: true } },
        },
      ])
    );
    expect(out.ok).toBe(true);
  });
});

describe("self-referential grants", () => {
  const escalating: PolicyStatement = {
    sid: "s1",
    effect: "allow",
    capability: ["policy.update"],
  };

  it("refuses to compile a grant over the policy system without acknowledgement", () => {
    const errs = errorsOf(doc([escalating], ["policy.update"]));
    expect(errs.join(" ")).toContain("acknowledgeSelfReferential");
  });

  it("compiles once the document acknowledges it", () => {
    const out = compile(
      doc([escalating], ["policy.update"], {
        acknowledgeSelfReferential: true,
      } as Partial<PolicyDocument>)
    );
    expect(out.ok).toBe(true);
  });

  it("does not require acknowledgement to deny the same capability", () => {
    const out = compile(
      doc(
        [{ sid: "s1", effect: "deny", capability: ["policy.update"] }],
        ["policy.update"]
      )
    );
    expect(out.ok).toBe(true);
  });
});

describe("catching rules that would silently never apply", () => {
  it("rejects a capability pattern that matches nothing", () => {
    const errs = errorsOf(
      doc([{ sid: "s1", effect: "allow", capability: ["protocol.lend.suply"] }])
    );
    expect(errs.join(" ")).toContain("matches no known capability");
  });

  it("rejects an unknown condition key", () => {
    const errs = errorsOf(
      doc([
        {
          sid: "s1",
          effect: "allow",
          capability: ["protocol.lending.supply"],
          condition: { usdVlaue: { lte: "100" } } as never,
        },
      ])
    );
    expect(errs.join(" ")).toContain("unknown condition");
  });

  it("rejects an unknown operator", () => {
    const errs = errorsOf(
      doc([
        {
          sid: "s1",
          effect: "allow",
          capability: ["protocol.lending.supply"],
          condition: { usdValue: { atMost: "100" } } as never,
        },
      ])
    );
    expect(errs.join(" ")).toContain("unknown operator");
  });

  it("rejects a malformed resource identifier", () => {
    const errs = errorsOf(
      doc([
        {
          sid: "s1",
          effect: "allow",
          capability: ["protocol.lending.supply"],
          resource: ["kh:galaxy/andromeda"],
        },
      ])
    );
    expect(errs.join(" ")).toContain("Unknown segment type");
  });

  it("rejects a duplicate statement id", () => {
    const errs = errorsOf(
      doc([
        { sid: "s1", effect: "allow", capability: ["protocol.lending.supply"] },
        { sid: "s1", effect: "deny", capability: ["protocol.lending.borrow"] },
      ])
    );
    expect(errs.join(" ")).toContain("Duplicate statement id");
  });

  it("rejects a statement that names no capability", () => {
    const errs = errorsOf(
      doc([{ sid: "s1", effect: "allow", capability: [] }])
    );
    expect(errs.join(" ")).toContain("never match");
  });

  it("rejects a limit attached to anything but an allow", () => {
    const errs = errorsOf(
      doc([
        {
          sid: "s1",
          effect: "deny",
          capability: ["protocol.lending.borrow"],
          limit: [
            { metric: "usd", window: "1d", max: "1000", scope: "organization" },
          ],
        },
      ])
    );
    expect(errs.join(" ")).toContain("Limits bound what an allow permits");
  });

  it("rejects an empty managed scope", () => {
    const errs = errorsOf(doc([], []));
    expect(errs.join(" ")).toContain("governs nothing");
  });

  it("rejects an unsupported schema version", () => {
    const errs = errorsOf(
      doc(
        [
          {
            sid: "s1",
            effect: "allow",
            capability: ["protocol.lending.supply"],
          },
        ],
        undefined,
        {
          schemaVersion: "1999-01",
        }
      )
    );
    expect(errs.join(" ")).toContain("Unsupported schema version");
  });
});

describe("warnings", () => {
  it("warns about managed capabilities no allow covers", () => {
    // The single most likely authoring mistake: claim a scope, forget to grant
    // back inside it, and every workflow using it stops.
    const out = compile(
      doc([
        { sid: "s1", effect: "allow", capability: ["protocol.lending.supply"] },
      ])
    );
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const text = out.warnings.join(" ");
    expect(text).toContain(Capability.PROTOCOL_LENDING_BORROW);
    expect(text).toContain(Capability.PROTOCOL_LENDING_WITHDRAW);
  });

  it("emits no warning when every managed capability is covered", () => {
    const out = compile(
      doc([{ sid: "s1", effect: "allow", capability: ["protocol.lending.**"] }])
    );
    expect(out.ok && out.warnings).toEqual([]);
  });
});
