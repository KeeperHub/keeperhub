import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import compoundDef from "@/protocols/compound-v3";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Compound V3 Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(compoundDef).toBeDefined();
    expect(compoundDef.name).toBe("Compound V3");
    expect(compoundDef.slug).toBe("compound");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(compoundDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of compoundDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(compoundDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(compoundDef.contracts));
    for (const action of compoundDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = compoundDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = compoundDef.actions.filter((a) => a.type === "read");
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

  it("each action's contract has at least one chain address", () => {
    for (const action of compoundDef.actions) {
      const contract = compoundDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 12 actions", () => {
    expect(compoundDef.actions).toHaveLength(12);
  });

  it("has 2 write actions and 10 read actions", () => {
    const readActions = compoundDef.actions.filter((a) => a.type === "read");
    const writeActions = compoundDef.actions.filter((a) => a.type === "write");
    expect(writeActions).toHaveLength(2);
    expect(readActions).toHaveLength(10);
  });

  it("has 1 contract", () => {
    expect(Object.keys(compoundDef.contracts)).toHaveLength(1);
  });

  it("comet contract uses userSpecifiedAddress", () => {
    expect(compoundDef.contracts.comet.userSpecifiedAddress).toBe(true);
  });

  it("comet contract is available on Ethereum, Base, and Arbitrum", () => {
    const chains = Object.keys(compoundDef.contracts.comet.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toHaveLength(3);
  });

  it("get-balance action has output without hardcoded decimals", () => {
    const action = compoundDef.actions.find((a) => a.slug === "get-balance");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0].name).toBe("balance");
    expect(action?.outputs?.[0].decimals).toBeUndefined();
  });

  it("get-collateral-balance action takes account and asset inputs", () => {
    const action = compoundDef.actions.find(
      (a) => a.slug === "get-collateral-balance"
    );
    expect(action).toBeDefined();
    expect(action?.inputs).toHaveLength(2);
    const inputNames = action?.inputs.map((i) => i.name);
    expect(inputNames).toContain("account");
    expect(inputNames).toContain("asset");
  });

  it("get-borrow-balance action has output without hardcoded decimals", () => {
    const action = compoundDef.actions.find(
      (a) => a.slug === "get-borrow-balance"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0].name).toBe("balance");
    expect(action?.outputs?.[0].decimals).toBeUndefined();
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(compoundDef);
    const retrieved = getProtocol("compound");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("compound");
    expect(retrieved?.name).toBe("Compound V3");
  });
});
