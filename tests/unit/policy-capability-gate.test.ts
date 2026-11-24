import { describe, expect, it } from "vitest";
import { PolicyEffect } from "@/lib/policy";
import {
  CompatibilityCode,
  CompatibilitySeverity,
  checkStatement,
  deriveContractCatalog,
  type ResolvedResource,
} from "@/lib/policy/catalog";
import type { PolicyStatement } from "@/lib/policy/types";

const POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";

const ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const catalog = deriveContractCatalog({
  chainId: 8453,
  address: POOL,
  abi: ABI as never,
});
const supply = catalog.entries.find((e) => e.name === "supply");
const borrow = catalog.entries.find((e) => e.name === "borrow");

function resource(selector: string): ResolvedResource {
  return {
    pattern: `kh:chain/8453/contract/${POOL}/fn/${selector}`,
    chainId: 8453,
    address: POOL,
    selector,
    catalog,
  };
}

function check(capability: string[], selectors: string[]) {
  const statement: PolicyStatement = {
    sid: "rule-1",
    effect: PolicyEffect.ALLOW,
    capability,
    resource: selectors.map(
      (selector) => `kh:chain/8453/contract/${POOL}/fn/${selector}`
    ),
  };
  return checkStatement(statement, selectors.map(resource)).filter(
    (finding) => finding.code === CompatibilityCode.CAPABILITY_MISMATCH
  );
}

describe("a rule whose action does not match the functions it names", () => {
  it("is an error when it can match none of them", () => {
    // The capability is a gate: a statement whose action does not include the
    // one a request carries never matches, whatever its resource says. So a
    // rule can name exactly the right contract and function and do nothing.
    const findings = check(["protocol.dex.swap"], [supply?.selector ?? ""]);
    expect(findings[0]?.severity).toBe(CompatibilitySeverity.ERROR);
    expect(findings[0]?.message).toContain("never applies");
  });

  it("names the action the selected functions actually need", () => {
    const findings = check(["protocol.dex.swap"], [supply?.selector ?? ""]);
    expect(findings[0]?.message).toContain("protocol.lending.supply");
  });

  it("is a warning when it covers some but not all", () => {
    const findings = check(
      ["protocol.lending.supply"],
      [supply?.selector ?? "", borrow?.selector ?? ""]
    );
    expect(findings[0]?.severity).toBe(CompatibilitySeverity.WARNING);
    expect(findings[0]?.message).toContain("protocol.lending.borrow");
  });

  it("says nothing when the action covers every function named", () => {
    expect(
      check(
        ["protocol.lending.supply", "protocol.lending.borrow"],
        [supply?.selector ?? "", borrow?.selector ?? ""]
      )
    ).toEqual([]);
  });
});
