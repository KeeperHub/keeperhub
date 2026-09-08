import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import cowswapDef from "@/protocols/cowswap";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("CoW Swap Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(cowswapDef).toBeDefined();
    expect(cowswapDef.name).toBe("CoW Swap");
    expect(cowswapDef.slug).toBe("cowswap");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(cowswapDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of cowswapDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      cowswapDef.contracts
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
    const contractKeys = new Set(Object.keys(cowswapDef.contracts));
    for (const action of cowswapDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = cowswapDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = cowswapDef.actions.filter((a) => a.type === "read");
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
    for (const action of cowswapDef.actions) {
      const contract = cowswapDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 10 actions", () => {
    expect(cowswapDef.actions).toHaveLength(10);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(cowswapDef);
    const retrieved = getProtocol("cowswap");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("cowswap");
    expect(retrieved?.name).toBe("CoW Swap");
  });

  it("has 6 read actions and 4 write actions", () => {
    const readActions = cowswapDef.actions.filter((a) => a.type === "read");
    const writeActions = cowswapDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(6);
    expect(writeActions).toHaveLength(4);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(cowswapDef.contracts)).toHaveLength(2);
  });

  it("both contracts are available on all 4 chains", () => {
    const expectedChains = new Set(["1", "8453", "42161", "10"]);
    for (const [key, contract] of Object.entries(cowswapDef.contracts)) {
      const chains = new Set(Object.keys(contract.addresses));
      expect(chains, `contract "${key}" chains`).toEqual(expectedChains);
    }
  });

  it("settlement contract uses deterministic CREATE2 address on all chains", () => {
    const addresses = Object.values(cowswapDef.contracts.settlement.addresses);
    const unique = new Set(addresses);
    expect(unique.size).toBe(1);
    expect(addresses[0]).toBe("0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
  });

  it("composableCow contract uses deterministic CREATE2 address on all chains", () => {
    const addresses = Object.values(
      cowswapDef.contracts.composableCow.addresses
    );
    const unique = new Set(addresses);
    expect(unique.size).toBe(1);
    expect(addresses[0]).toBe("0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74");
  });
});
