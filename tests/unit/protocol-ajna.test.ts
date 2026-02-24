import { describe, expect, it } from "vitest";
import {
  getProtocol,
  registerProtocol,
} from "@/keeperhub/lib/protocol-registry";
import ajnaProtocol from "@/keeperhub/protocols/ajna";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Ajna Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(ajnaProtocol).toBeDefined();
    expect(ajnaProtocol.name).toBe("Ajna");
    expect(ajnaProtocol.slug).toBe("ajna");
  });

  it("has correct slug", () => {
    expect(ajnaProtocol.slug).toBe("ajna");
    expect(ajnaProtocol.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs match kebab-case pattern", () => {
    for (const action of ajnaProtocol.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid hex", () => {
    for (const [key, contract] of Object.entries(ajnaProtocol.contracts)) {
      for (const [chainId, addr] of Object.entries(contract.addresses)) {
        expect(addr, `${key}[${chainId}] invalid`).toMatch(HEX_ADDRESS_REGEX);
        expect(addr, `${key}[${chainId}] length`).toHaveLength(42);
      }
    }
  });

  it("all action.contract values reference existing contracts", () => {
    const contractKeys = new Set(Object.keys(ajnaProtocol.contracts));
    for (const action of ajnaProtocol.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = ajnaProtocol.actions.map((a) => a.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it("all read actions with return values have outputs defined", () => {
    for (const action of ajnaProtocol.actions) {
      if (action.type === "read") {
        expect(
          action.outputs,
          `read action "${action.slug}" must have outputs`
        ).toBeDefined();
        expect(
          action.outputs?.length,
          `read action "${action.slug}" must have at least one output`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("has expected action count", () => {
    expect(ajnaProtocol.actions.length).toBe(48);
  });

  it("has expected contract count", () => {
    expect(Object.keys(ajnaProtocol.contracts).length).toBe(9);
  });

  it("all contracts have at least one chain address", () => {
    for (const [key, contract] of Object.entries(ajnaProtocol.contracts)) {
      expect(
        Object.keys(contract.addresses).length,
        `contract "${key}" must have at least one chain address`
      ).toBeGreaterThan(0);
    }
  });

  it("all contracts are Base-only", () => {
    for (const [key, contract] of Object.entries(ajnaProtocol.contracts)) {
      const chains = Object.keys(contract.addresses);
      expect(chains, `contract "${key}" should only be on Base (8453)`).toEqual(
        ["8453"]
      );
    }
  });

  it("has 30 read actions and 18 write actions", () => {
    const readActions = ajnaProtocol.actions.filter((a) => a.type === "read");
    const writeActions = ajnaProtocol.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(30);
    expect(writeActions).toHaveLength(18);
  });

  it("is registered and retrievable after explicit registration", () => {
    registerProtocol(ajnaProtocol);
    const registered = getProtocol("ajna");
    expect(registered).toBeDefined();
    expect(registered?.slug).toBe("ajna");
    expect(registered?.name).toBe("Ajna");
  });
});
