import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Uniswap Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(uniswapDef).toBeDefined();
    expect(uniswapDef.name).toBe("Uniswap V3");
    expect(uniswapDef.slug).toBe("uniswap");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(uniswapDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of uniswapDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      uniswapDef.contracts
    )) {
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
    const contractKeys = new Set(Object.keys(uniswapDef.contracts));
    for (const action of uniswapDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = uniswapDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = uniswapDef.actions.filter((a) => a.type === "read");
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
    for (const action of uniswapDef.actions) {
      const contract = uniswapDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 11 actions", () => {
    expect(uniswapDef.actions).toHaveLength(11);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(uniswapDef);
    const retrieved = getProtocol("uniswap");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("uniswap");
    expect(retrieved?.name).toBe("Uniswap V3");
  });

  it("has 6 read actions and 5 write actions", () => {
    const readActions = uniswapDef.actions.filter((a) => a.type === "read");
    const writeActions = uniswapDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(6);
    expect(writeActions).toHaveLength(5);
  });

  it("has 4 contracts", () => {
    expect(Object.keys(uniswapDef.contracts)).toHaveLength(4);
  });

  it("all contracts are available on 5 chains", () => {
    for (const [key, contract] of Object.entries(uniswapDef.contracts)) {
      const chains = Object.keys(contract.addresses);
      expect(chains, `${key} should have 5 chains`).toHaveLength(5);
      expect(contract.addresses["1"]).toBeDefined();
      expect(contract.addresses["8453"]).toBeDefined();
      expect(contract.addresses["42161"]).toBeDefined();
      expect(contract.addresses["10"]).toBeDefined();
      expect(contract.addresses["11155111"]).toBeDefined();
    }
  });

  it("get-position action returns 12 output fields", () => {
    const getPosition = uniswapDef.actions.find(
      (a) => a.slug === "get-position"
    );
    expect(getPosition).toBeDefined();
    expect(getPosition?.outputs).toHaveLength(12);
  });
});
