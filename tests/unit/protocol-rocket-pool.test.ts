import { describe, expect, it } from "vitest";
import {
  getProtocol,
  protocolActionToPluginAction,
  registerProtocol,
} from "@/lib/protocol-registry";
import rocketPoolDef from "@/protocols/rocket-pool";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Rocket Pool Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(rocketPoolDef).toBeDefined();
    expect(rocketPoolDef.name).toBe("Rocket Pool");
    expect(rocketPoolDef.slug).toBe("rocket-pool");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(rocketPoolDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of rocketPoolDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(rocketPoolDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(rocketPoolDef.contracts));
    for (const action of rocketPoolDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = rocketPoolDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = rocketPoolDef.actions.filter((a) => a.type === "read");
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
    for (const action of rocketPoolDef.actions) {
      const contract = rocketPoolDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 6 actions", () => {
    expect(rocketPoolDef.actions).toHaveLength(6);
  });

  it("has 2 write actions and 4 read actions", () => {
    const readActions = rocketPoolDef.actions.filter((a) => a.type === "read");
    const writeActions = rocketPoolDef.actions.filter(
      (a) => a.type === "write"
    );
    expect(writeActions).toHaveLength(2);
    expect(readActions).toHaveLength(4);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(rocketPoolDef.contracts)).toHaveLength(2);
  });

  it("reth contract is available on Ethereum Mainnet", () => {
    const chains = Object.keys(rocketPoolDef.contracts.reth.addresses);
    expect(chains).toContain("1");
  });

  it("depositPool contract is available on Ethereum Mainnet", () => {
    const chains = Object.keys(rocketPoolDef.contracts.depositPool.addresses);
    expect(chains).toContain("1");
  });

  it("getExchangeRate has 1 output matching rETH return value", () => {
    const action = rocketPoolDef.actions.find(
      (a) => a.slug === "get-exchange-rate"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("rate");
  });

  it("balanceOf has 1 output matching ERC-20 return value", () => {
    const action = rocketPoolDef.actions.find((a) => a.slug === "balance-of");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("balance");
  });

  it("totalSupply has 1 output", () => {
    const action = rocketPoolDef.actions.find((a) => a.slug === "total-supply");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("totalSupply");
  });

  it("getTotalCollateral has 1 output", () => {
    const action = rocketPoolDef.actions.find(
      (a) => a.slug === "get-total-collateral"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("totalCollateral");
  });

  it("has 3 events", () => {
    expect(rocketPoolDef.events).toHaveLength(3);
  });

  it("all event slugs are valid kebab-case", () => {
    for (const event of rocketPoolDef.events ?? []) {
      expect(event.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every event references an existing contract", () => {
    const contractKeys = new Set(Object.keys(rocketPoolDef.contracts));
    for (const event of rocketPoolDef.events ?? []) {
      expect(
        contractKeys.has(event.contract),
        `event "${event.slug}" references unknown contract "${event.contract}"`
      ).toBe(true);
    }
  });

  it("write actions do not surface ABI-derived outputs as UI template suggestions (KEEP-296)", () => {
    for (const slug of ["burn", "deposit"]) {
      const action = rocketPoolDef.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" not found`).toBeDefined();
      if (!action) {
        continue;
      }
      expect(action.type).toBe("write");
      const pluginAction = protocolActionToPluginAction(rocketPoolDef, action);
      const outputFieldNames = (pluginAction.outputFields ?? []).map(
        (f) => f.field
      );
      expect(outputFieldNames).toEqual(
        expect.arrayContaining([
          "success",
          "error",
          "transactionHash",
          "transactionLink",
        ])
      );
    }
  });

  it("burn renames the on-chain _rethAmount parameter to 'amount'", () => {
    const burn = rocketPoolDef.actions.find((a) => a.slug === "burn");
    expect(burn).toBeDefined();
    expect(burn?.function).toBe("burn");
    expect(burn?.inputs).toHaveLength(1);
    expect(burn?.inputs[0].name).toBe("amount");
    expect(burn?.inputs[0].type).toBe("uint256");
  });

  it("deposit is a payable write with no inputs", () => {
    const deposit = rocketPoolDef.actions.find((a) => a.slug === "deposit");
    expect(deposit).toBeDefined();
    expect(deposit?.type).toBe("write");
    expect(deposit?.payable).toBe(true);
    expect(deposit?.inputs).toHaveLength(0);
  });

  it("events derive from the curated ABI with overridden labels and descriptions", () => {
    const tokensMinted = rocketPoolDef.events?.find(
      (e) => e.eventName === "TokensMinted"
    );
    expect(tokensMinted).toBeDefined();
    expect(tokensMinted?.slug).toBe("tokens-minted");
    expect(tokensMinted?.label).toBe("rETH Minted");
    expect(tokensMinted?.inputs).toHaveLength(4);
    expect(tokensMinted?.inputs[0]).toEqual({
      name: "to",
      type: "address",
      indexed: true,
    });

    const depositReceived = rocketPoolDef.events?.find(
      (e) => e.eventName === "DepositReceived"
    );
    expect(depositReceived).toBeDefined();
    expect(depositReceived?.contract).toBe("depositPool");
    expect(depositReceived?.inputs).toHaveLength(3);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(rocketPoolDef);
    const retrieved = getProtocol("rocket-pool");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("rocket-pool");
    expect(retrieved?.name).toBe("Rocket Pool");
  });
});
