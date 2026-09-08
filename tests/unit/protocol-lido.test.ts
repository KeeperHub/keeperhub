import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import lidoDef from "@/protocols/lido";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Lido Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(lidoDef).toBeDefined();
    expect(lidoDef.name).toBe("Lido");
    expect(lidoDef.slug).toBe("lido");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(lidoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of lidoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(lidoDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(lidoDef.contracts));
    for (const action of lidoDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = lidoDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = lidoDef.actions.filter((a) => a.type === "read");
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
    for (const action of lidoDef.actions) {
      const contract = lidoDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 10 actions", () => {
    expect(lidoDef.actions).toHaveLength(10);
  });

  it("has 3 write actions and 7 read actions", () => {
    const readActions = lidoDef.actions.filter((a) => a.type === "read");
    const writeActions = lidoDef.actions.filter((a) => a.type === "write");
    expect(writeActions).toHaveLength(3);
    expect(readActions).toHaveLength(7);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(lidoDef.contracts)).toHaveLength(2);
  });

  it("wsteth contract is available on Mainnet, Base, and Sepolia", () => {
    const chains = Object.keys(lidoDef.contracts.wsteth.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("11155111");
  });

  it("steth contract is available on Mainnet and Sepolia", () => {
    const chains = Object.keys(lidoDef.contracts.steth.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("11155111");
  });

  it("getStETHByWstETH has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-steth-by-wsteth"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("stETHAmount");
  });

  it("getWstETHByStETH has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-by-steth"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("wstETHAmount");
  });

  it("stEthPerToken has 1 output", () => {
    const action = lidoDef.actions.find((a) => a.slug === "steth-per-token");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("rate");
  });

  it("tokensPerStEth has 1 output", () => {
    const action = lidoDef.actions.find((a) => a.slug === "tokens-per-steth");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("rate");
  });

  it("balanceOf actions have 1 output each", () => {
    const wstethBalance = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-balance"
    );
    const stethBalance = lidoDef.actions.find(
      (a) => a.slug === "get-steth-balance"
    );
    expect(wstethBalance?.outputs).toHaveLength(1);
    expect(stethBalance?.outputs).toHaveLength(1);
  });

  it("totalSupply has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-total-supply"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("totalSupply");
  });

  it("has 1 event", () => {
    expect(lidoDef.events).toHaveLength(1);
  });

  it("all event slugs are valid kebab-case", () => {
    for (const event of lidoDef.events ?? []) {
      expect(event.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every event references an existing contract", () => {
    const contractKeys = new Set(Object.keys(lidoDef.contracts));
    for (const event of lidoDef.events ?? []) {
      expect(
        contractKeys.has(event.contract),
        `event "${event.slug}" references unknown contract "${event.contract}"`
      ).toBe(true);
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(lidoDef);
    const retrieved = getProtocol("lido");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("lido");
    expect(retrieved?.name).toBe("Lido");
  });
});
