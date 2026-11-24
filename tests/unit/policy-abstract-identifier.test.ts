import { describe, expect, it } from "vitest";
import { POLICY_SCHEMA_VERSION, PolicyEnforcementMode } from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import type { PolicyDocument } from "@/lib/policy/types";

/**
 * A rule written against an ontology class governs nothing.
 *
 * Decisions are matched against the chain, contract and selector that were
 * actually called, so a class never matches one. Such a policy used to compile,
 * appear in the list and leave the action it named unmanaged, which is the
 * worst of both: the author believes a protocol is covered and nothing is.
 *
 * Expanding a class into its deployments is the ontology's job and is not
 * built, so until it is, the rule is refused rather than stored in a form that
 * cannot bite.
 */
function compile(manages: string[], resource?: string[]) {
  return compilePolicy({
    id: "pol_1",
    enabled: true,
    document: {
      schemaVersion: POLICY_SCHEMA_VERSION,
      name: "Test",
      enforcement: PolicyEnforcementMode.ENFORCE,
      manages,
      statements: [
        {
          sid: "s1",
          effect: "deny",
          capability: ["protocol.lending.supply"],
          ...(resource ? { resource } : {}),
        },
      ],
    } as unknown as PolicyDocument,
  });
}

const CONCRETE =
  "kh:chain/8453/contract/0xa238dd80c259a72e81d7e4664a9801593f98d1c5/fn/0x617ba037";

describe("an identifier that names a class", () => {
  it("is refused in a managed scope", () => {
    const out = compile(["kh:protocol/aave-v3/**"]);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.map((e) => e.message).join(" ")).toContain(
        "names a class"
      );
    }
  });

  it("is refused in a statement's resource", () => {
    const out = compile(["protocol.lending.**"], ["kh:protocol/aave-v3/**"]);

    expect(out.ok).toBe(false);
  });

  it("is refused for an asset class", () => {
    expect(compile(["kh:asset/class/stablecoin"]).ok).toBe(false);
  });

  it("accepts the deployment it stands for", () => {
    const out = compile([CONCRETE]);
    expect(out.ok).toBe(true);
  });

  it("still accepts a capability scope, which is not a resource at all", () => {
    expect(compile(["protocol.lending.**"]).ok).toBe(true);
  });

  it("still accepts a wildcard over concrete identifiers", () => {
    // Any contract on Base. A wildcard still names onchain state, so it is the
    // class that is refused rather than the breadth.
    expect(compile(["kh:chain/8453/contract/*"]).ok).toBe(true);
  });
});
