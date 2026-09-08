import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import pendleDef from "@/protocols/pendle";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Pendle Finance Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(pendleDef).toBeDefined();
    expect(pendleDef.name).toBe("Pendle Finance");
    expect(pendleDef.slug).toBe("pendle");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(pendleDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of pendleDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(pendleDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(pendleDef.contracts));
    for (const action of pendleDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = pendleDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = pendleDef.actions.filter((a) => a.type === "read");
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
    for (const action of pendleDef.actions) {
      const contract = pendleDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 14 actions", () => {
    expect(pendleDef.actions).toHaveLength(14);
  });

  it("has 12 read actions and 2 write actions", () => {
    const readActions = pendleDef.actions.filter((a) => a.type === "read");
    const writeActions = pendleDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(12);
    expect(writeActions).toHaveLength(2);
  });

  it("has 6 contracts", () => {
    expect(Object.keys(pendleDef.contracts)).toHaveLength(6);
  });

  it("router contract is available on Ethereum and Base", () => {
    const chains = Object.keys(pendleDef.contracts.router.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
  });

  it("vePendle contract is Ethereum-only", () => {
    const chains = Object.keys(pendleDef.contracts.vePendle.addresses);
    expect(chains).toHaveLength(1);
    expect(chains).toContain("1");
  });

  it("market, pt, yt, sy contracts have userSpecifiedAddress enabled", () => {
    expect(pendleDef.contracts.market.userSpecifiedAddress).toBe(true);
    expect(pendleDef.contracts.pt.userSpecifiedAddress).toBe(true);
    expect(pendleDef.contracts.yt.userSpecifiedAddress).toBe(true);
    expect(pendleDef.contracts.sy.userSpecifiedAddress).toBe(true);
  });

  it("router contract does not have userSpecifiedAddress", () => {
    expect(pendleDef.contracts.router.userSpecifiedAddress).toBeUndefined();
  });

  it("vePendle contract does not have userSpecifiedAddress", () => {
    expect(pendleDef.contracts.vePendle.userSpecifiedAddress).toBeUndefined();
  });

  it("userSpecifiedAddress contracts are available on Ethereum and Base", () => {
    const userContracts = ["market", "pt", "yt", "sy"] as const;
    for (const key of userContracts) {
      const chains = Object.keys(pendleDef.contracts[key].addresses);
      expect(chains, `contract "${key}" should be on Ethereum`).toContain("1");
      expect(chains, `contract "${key}" should be on Base`).toContain("8453");
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(pendleDef);
    const retrieved = getProtocol("pendle");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("pendle");
    expect(retrieved?.name).toBe("Pendle Finance");
  });
});
