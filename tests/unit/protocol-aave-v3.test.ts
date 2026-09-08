import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import aaveV3Def from "@/protocols/aave-v3";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Aave V3 Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(aaveV3Def).toBeDefined();
    expect(aaveV3Def.name).toBe("Aave V3");
    expect(aaveV3Def.slug).toBe("aave-v3");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(aaveV3Def.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of aaveV3Def.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(aaveV3Def.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(aaveV3Def.contracts));
    for (const action of aaveV3Def.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = aaveV3Def.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = aaveV3Def.actions.filter((a) => a.type === "read");
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
    for (const action of aaveV3Def.actions) {
      const contract = aaveV3Def.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 7 actions", () => {
    expect(aaveV3Def.actions).toHaveLength(7);
  });

  it("has 5 write actions and 2 read actions", () => {
    const readActions = aaveV3Def.actions.filter((a) => a.type === "read");
    const writeActions = aaveV3Def.actions.filter((a) => a.type === "write");
    expect(writeActions).toHaveLength(5);
    expect(readActions).toHaveLength(2);
  });

  it("has 2 contracts", () => {
    expect(Object.keys(aaveV3Def.contracts)).toHaveLength(2);
  });

  it("pool contract is available on mainnets and testnets", () => {
    const chains = Object.keys(aaveV3Def.contracts.pool.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
    expect(chains).toContain("11155111");
    expect(chains).toContain("84532");
  });

  it("poolDataProvider contract is available on mainnets and testnets", () => {
    const chains = Object.keys(aaveV3Def.contracts.poolDataProvider.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
    expect(chains).toContain("11155111");
    expect(chains).toContain("84532");
  });

  it("uses current Aave V3 PoolDataProvider addresses", () => {
    expect(aaveV3Def.contracts.poolDataProvider.addresses).toMatchObject({
      "1": "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
      "8453": "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
      "42161": "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
      "10": "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
      "11155111": "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
      "84532": "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
    });
  });

  it("getUserAccountData has 6 outputs matching Pool return values", () => {
    const action = aaveV3Def.actions.find(
      (a) => a.slug === "get-user-account-data"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(6);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("totalCollateralBase");
    expect(outputNames).toContain("totalDebtBase");
    expect(outputNames).toContain("healthFactor");
  });

  it("getUserReserveData has 9 outputs matching PoolDataProvider return values", () => {
    const action = aaveV3Def.actions.find(
      (a) => a.slug === "get-user-reserve-data"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(9);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("currentATokenBalance");
    expect(outputNames).toContain("currentVariableDebtTokenBalance");
    expect(outputNames).toContain("usageAsCollateralEnabled");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(aaveV3Def);
    const retrieved = getProtocol("aave-v3");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("aave-v3");
    expect(retrieved?.name).toBe("Aave V3");
  });
});
