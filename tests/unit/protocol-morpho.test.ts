import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import morphoDef from "@/protocols/morpho";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Morpho Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(morphoDef).toBeDefined();
    expect(morphoDef.name).toBe("Morpho");
    expect(morphoDef.slug).toBe("morpho");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(morphoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of morphoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(morphoDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(address, `${contractKey} on chain ${chain}`).toMatch(
          HEX_ADDRESS_REGEX
        );
        expect(address, `${contractKey} on chain ${chain} length`).toHaveLength(
          42
        );
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(morphoDef.contracts));
    for (const action of morphoDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = morphoDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = morphoDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(
        action.outputs?.length,
        `read action "${action.slug}" must have at least one output`
      ).toBeGreaterThan(0);
    }
  });

  it("each action's contract has at least one chain address or is user-specified", () => {
    for (const action of morphoDef.actions) {
      const contract = morphoDef.contracts[action.contract];
      expect(contract).toBeDefined();
      if (!contract.userSpecifiedAddress) {
        expect(
          Object.keys(contract.addresses).length,
          `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("has exactly 32 actions", () => {
    expect(morphoDef.actions).toHaveLength(32);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(morphoDef.contracts)).toHaveLength(2);
  });

  it("has 18 read actions and 14 write actions", () => {
    const readActions = morphoDef.actions.filter((a) => a.type === "read");
    const writeActions = morphoDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(18);
    expect(writeActions).toHaveLength(14);
  });

  it("all MarketParams actions include the 5 struct fields as flat inputs", () => {
    const marketParamsSlugs = [
      "supply",
      "withdraw",
      "borrow",
      "repay",
      "supply-collateral",
      "withdraw-collateral",
      "liquidate",
      "accrue-interest",
    ];
    const structFields = [
      "loanToken",
      "collateralToken",
      "oracle",
      "irm",
      "lltv",
    ];
    for (const slug of marketParamsSlugs) {
      const action = morphoDef.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" must exist`).toBeDefined();
      const inputNames = action?.inputs.map((i) => i.name) ?? [];
      for (const field of structFields) {
        expect(
          inputNames.includes(field),
          `action "${slug}" must include MarketParams field "${field}"`
        ).toBe(true);
      }
    }
  });

  it("morpho contract is available on 3 chains", () => {
    expect(Object.keys(morphoDef.contracts.morpho.addresses)).toHaveLength(3);
    expect(morphoDef.contracts.morpho.addresses["1"]).toBeDefined();
    expect(morphoDef.contracts.morpho.addresses["8453"]).toBeDefined();
    expect(morphoDef.contracts.morpho.addresses["11155111"]).toBeDefined();
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(morphoDef);
    const retrieved = getProtocol("morpho");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("morpho");
    expect(retrieved?.name).toBe("Morpho");
  });
});
