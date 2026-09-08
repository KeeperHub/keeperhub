import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import sparkDef from "@/protocols/spark";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Spark Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(sparkDef).toBeDefined();
    expect(sparkDef.name).toBe("Spark");
    expect(sparkDef.slug).toBe("spark");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(sparkDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of sparkDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(sparkDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(sparkDef.contracts));
    for (const action of sparkDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = sparkDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = sparkDef.actions.filter((a) => a.type === "read");
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
    for (const action of sparkDef.actions) {
      const contract = sparkDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 25 actions", () => {
    expect(sparkDef.actions).toHaveLength(25);
  });

  it("has 9 write actions and 16 read actions", () => {
    const readActions = sparkDef.actions.filter((a) => a.type === "read");
    const writeActions = sparkDef.actions.filter((a) => a.type === "write");
    expect(writeActions).toHaveLength(9);
    expect(readActions).toHaveLength(16);
  });

  it("has 3 contracts", () => {
    expect(Object.keys(sparkDef.contracts)).toHaveLength(3);
  });

  it("pool and poolDataProvider are available on Gnosis Chain", () => {
    expect(Object.keys(sparkDef.contracts.pool.addresses)).toContain("100");
    expect(
      Object.keys(sparkDef.contracts.poolDataProvider.addresses)
    ).toContain("100");
  });

  it("sDAI is Ethereum-only (no Gnosis)", () => {
    const sdaiChains = Object.keys(sparkDef.contracts.sdai.addresses);
    expect(sdaiChains).toContain("1");
    expect(sdaiChains).not.toContain("100");
  });

  it("get-user-reserve-data uses poolDataProvider contract", () => {
    const action = sparkDef.actions.find(
      (a) => a.slug === "get-user-reserve-data"
    );
    expect(action).toBeDefined();
    expect(action?.contract).toBe("poolDataProvider");
    expect(action?.outputs?.length).toBeGreaterThan(0);
  });

  it("all contracts are available on Ethereum mainnet", () => {
    for (const [key, contract] of Object.entries(sparkDef.contracts)) {
      const chains = Object.keys(contract.addresses);
      expect(
        chains,
        `contract "${key}" must include Ethereum mainnet`
      ).toContain("1");
    }
  });

  it("getUserAccountData has 6 outputs matching Pool return values", () => {
    const action = sparkDef.actions.find(
      (a) => a.slug === "get-user-account-data"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(6);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("totalCollateralBase");
    expect(outputNames).toContain("totalDebtBase");
    expect(outputNames).toContain("healthFactor");
  });

  it("sDAI vault read actions have correct outputs", () => {
    const balanceAction = sparkDef.actions.find(
      (a) => a.slug === "vault-balance"
    );
    expect(balanceAction).toBeDefined();
    expect(balanceAction?.outputs).toHaveLength(1);
    expect(balanceAction?.outputs?.[0]?.name).toBe("balance");

    const totalAssetsAction = sparkDef.actions.find(
      (a) => a.slug === "vault-total-assets"
    );
    expect(totalAssetsAction).toBeDefined();
    expect(totalAssetsAction?.outputs).toHaveLength(1);
    expect(totalAssetsAction?.outputs?.[0]?.name).toBe("totalAssets");

    const convertAction = sparkDef.actions.find(
      (a) => a.slug === "vault-convert-to-assets"
    );
    expect(convertAction).toBeDefined();
    expect(convertAction?.outputs).toHaveLength(1);
    expect(convertAction?.outputs?.[0]?.name).toBe("assets");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(sparkDef);
    const retrieved = getProtocol("spark");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("spark");
    expect(retrieved?.name).toBe("Spark");
  });
});
