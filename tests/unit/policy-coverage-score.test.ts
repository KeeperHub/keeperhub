import { describe, expect, it } from "vitest";
import {
  Capability,
  POLICY_SCHEMA_VERSION,
  type PolicyDocument,
  PolicyEnforcementMode,
  type PolicyStatement,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { scorePolicy } from "@/lib/policy/coverage";

function compiled(
  statements: PolicyStatement[],
  manages = ["asset.transfer.**"]
) {
  const document: PolicyDocument = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    name: "Coverage",
    enforcement: PolicyEnforcementMode.ENFORCE,
    manages,
    statements,
  };
  const out = compilePolicy({ id: "pol_1", enabled: true, document });
  if (!out.ok) {
    throw new Error(out.errors.map((e) => e.message).join("; "));
  }
  return out.compiled;
}

describe("coverage score", () => {
  it("scores zero when a policy binds nothing", () => {
    // A bare allow names no dimension at all, so nothing about the action is
    // constrained beyond the capability itself.
    const coverage = scorePolicy(
      compiled([
        {
          sid: "s1",
          effect: "allow",
          capability: ["asset.transfer.token"],
        },
      ])
    );
    const token = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_TOKEN
    );
    expect(token?.score).toBe(0);
    expect(token?.bound).toEqual([]);
  });

  it("counts a dimension as bound when a condition names it", () => {
    const coverage = scorePolicy(
      compiled([
        {
          sid: "s1",
          effect: "allow",
          capability: ["asset.transfer.token"],
          condition: {
            usdValue: { lte: "1000" },
            triggerType: { in: ["manual"] },
          },
        },
      ])
    );
    const token = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_TOKEN
    );
    expect(token?.bound).toContain("amount");
    expect(token?.bound).toContain("trigger");
    expect(token?.score).toBeGreaterThan(0);
  });

  it("counts a limit as binding both amount and frequency", () => {
    const coverage = scorePolicy(
      compiled([
        {
          sid: "s1",
          effect: "allow",
          capability: ["asset.transfer.token"],
          limit: [
            { metric: "usd", window: "1d", max: "1000", scope: "organization" },
          ],
        },
      ])
    );
    const token = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_TOKEN
    );
    expect(token?.bound).toContain("amount");
    expect(token?.bound).toContain("frequency");
  });

  it("does not credit a capability for a rule about a different one", () => {
    // A rule about native transfers says nothing about how well token
    // transfers are bounded, so the token score must not inherit it.
    const coverage = scorePolicy(
      compiled([
        {
          sid: "s1",
          effect: "allow",
          capability: ["asset.transfer.native"],
          condition: { usdValue: { lte: "1000" } },
        },
        {
          sid: "s2",
          effect: "allow",
          capability: ["asset.transfer.token"],
        },
      ])
    );
    const native = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_NATIVE
    );
    const token = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_TOKEN
    );
    expect(native?.bound).toContain("amount");
    expect(token?.bound).not.toContain("amount");
  });

  it("names what is left unbound, which is the point", () => {
    const coverage = scorePolicy(
      compiled([
        {
          sid: "s1",
          effect: "allow",
          capability: ["asset.transfer.token"],
          condition: { usdValue: { lte: "1000" } },
        },
      ])
    );
    const token = coverage.perCapability.find(
      (c) => c.capability === Capability.ASSET_TRANSFER_TOKEN
    );
    expect(token?.unbound).toContain("counterparty");
    expect(token?.unbound).toContain("chain");
  });
});
