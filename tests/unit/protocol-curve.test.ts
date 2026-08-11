import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import curveDef from "@/protocols/curve";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Curve Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(curveDef).toBeDefined();
    expect(curveDef.name).toBe("Curve");
    expect(curveDef.slug).toBe("curve");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(curveDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of curveDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(curveDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(curveDef.contracts));
    for (const action of curveDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = curveDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = curveDef.actions.filter((a) => a.type === "read");
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
    for (const action of curveDef.actions) {
      const contract = curveDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 10 actions", () => {
    expect(curveDef.actions).toHaveLength(10);
  });

  it("has 6 read actions and 4 write actions", () => {
    const readActions = curveDef.actions.filter((a) => a.type === "read");
    const writeActions = curveDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(6);
    expect(writeActions).toHaveLength(4);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(curveDef.contracts)).toHaveLength(2);
  });

  it("pool contract is available on Ethereum, Base, Arbitrum, and Optimism", () => {
    const chains = Object.keys(curveDef.contracts.pool.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
  });

  it("crvToken contract is available on Ethereum, Arbitrum, and Optimism (not Base)", () => {
    const chains = Object.keys(curveDef.contracts.crvToken.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
    expect(chains).not.toContain("8453");
  });

  it("pool contract has userSpecifiedAddress enabled", () => {
    expect(curveDef.contracts.pool.userSpecifiedAddress).toBe(true);
  });

  it("crvToken contract does not have userSpecifiedAddress", () => {
    expect(curveDef.contracts.crvToken.userSpecifiedAddress).toBeUndefined();
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(curveDef);
    const retrieved = getProtocol("curve");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("curve");
    expect(retrieved?.name).toBe("Curve");
  });
});
