import { describe, expect, it } from "vitest";
import {
  getProtocol,
  protocolActionToPluginAction,
  registerProtocol,
} from "@/lib/protocol-registry";
import aaveV4Def from "@/protocols/aave-v4";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Aave V4 Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(aaveV4Def).toBeDefined();
    expect(aaveV4Def.name).toBe("Aave V4");
    expect(aaveV4Def.slug).toBe("aave-v4");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(aaveV4Def.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of aaveV4Def.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(aaveV4Def.contracts));
    for (const action of aaveV4Def.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = aaveV4Def.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = aaveV4Def.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(aaveV4Def.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has 9 actions covering V3 parity + reserveId resolver + getUserAccountData", () => {
    expect(aaveV4Def.actions).toHaveLength(9);
    const slugs = aaveV4Def.actions.map((a) => a.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "supply",
        "withdraw",
        "borrow",
        "repay",
        "set-collateral",
        "get-reserve-id",
        "get-user-supplied-assets",
        "get-user-debt",
        "get-user-account-data",
      ])
    );
  });

  it("has 5 write actions and 4 read actions", () => {
    const reads = aaveV4Def.actions.filter((a) => a.type === "read");
    const writes = aaveV4Def.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(4);
    expect(writes).toHaveLength(5);
  });

  it("has 1 contract (Lido Spoke only for this first cut)", () => {
    expect(Object.keys(aaveV4Def.contracts)).toHaveLength(1);
    expect(aaveV4Def.contracts.lidoSpoke).toBeDefined();
  });

  it("Lido Spoke is available on Ethereum mainnet only (V4 launch state)", () => {
    const chains = Object.keys(aaveV4Def.contracts.lidoSpoke.addresses);
    expect(chains).toHaveLength(1);
    expect(chains).toContain("1");
  });

  it("supply action has reserveId/amount/onBehalfOf inputs and is a write", () => {
    const supply = aaveV4Def.actions.find((a) => a.slug === "supply");
    expect(supply).toBeDefined();
    expect(supply?.type).toBe("write");
    expect(supply?.function).toBe("supply");
    expect(supply?.inputs).toHaveLength(3);
    expect(supply?.inputs.map((i) => i.name)).toEqual([
      "reserveId",
      "amount",
      "onBehalfOf",
    ]);
    expect(supply?.inputs[0].type).toBe("uint256");
    expect(supply?.inputs[1].type).toBe("uint256");
    expect(supply?.inputs[2].type).toBe("address");
  });

  it("set-collateral action has a bool input", () => {
    const setCollateral = aaveV4Def.actions.find(
      (a) => a.slug === "set-collateral"
    );
    expect(setCollateral).toBeDefined();
    expect(setCollateral?.type).toBe("write");
    expect(setCollateral?.function).toBe("setUsingAsCollateral");
    const boolInput = setCollateral?.inputs.find(
      (i) => i.name === "usingAsCollateral"
    );
    expect(boolInput?.type).toBe("bool");
  });

  it("get-reserve-id action has renamed output 'reserveId'", () => {
    const getReserveId = aaveV4Def.actions.find(
      (a) => a.slug === "get-reserve-id"
    );
    expect(getReserveId).toBeDefined();
    expect(getReserveId?.type).toBe("read");
    expect(getReserveId?.outputs).toHaveLength(1);
    expect(getReserveId?.outputs?.[0].name).toBe("reserveId");
    expect(getReserveId?.outputs?.[0].type).toBe("uint256");
  });

  it("get-user-debt action returns two uint256 outputs (drawnDebt + premiumDebt)", () => {
    const getUserDebt = aaveV4Def.actions.find(
      (a) => a.slug === "get-user-debt"
    );
    expect(getUserDebt).toBeDefined();
    expect(getUserDebt?.type).toBe("read");
    expect(getUserDebt?.outputs).toHaveLength(2);
    expect(getUserDebt?.outputs?.[0].name).toBe("drawnDebt");
    expect(getUserDebt?.outputs?.[1].name).toBe("premiumDebt");
  });

  it("get-user-supplied-assets action has a single named output", () => {
    const getSupplied = aaveV4Def.actions.find(
      (a) => a.slug === "get-user-supplied-assets"
    );
    expect(getSupplied).toBeDefined();
    expect(getSupplied?.type).toBe("read");
    expect(getSupplied?.outputs).toHaveLength(1);
    expect(getSupplied?.outputs?.[0].name).toBe("suppliedAmount");
  });

  it("write actions do not surface ABI-derived outputs as UI template suggestions (KEEP-296)", () => {
    // writeContractCore returns result: undefined, so any action.outputs on
    // write actions must not flow into pluginAction.outputFields (which
    // drives template autocomplete). Gated in buildOutputFieldsFromAction.
    for (const slug of ["supply", "withdraw", "borrow", "repay"]) {
      const action = aaveV4Def.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" not found`).toBeDefined();
      if (!action) {
        continue;
      }
      expect(action.type).toBe("write");
      const pluginAction = protocolActionToPluginAction(aaveV4Def, action);
      const outputFieldNames = (pluginAction.outputFields ?? []).map(
        (f) => f.field
      );
      // No ABI-derived outputs leak through
      expect(outputFieldNames).not.toContain("result0");
      expect(outputFieldNames).not.toContain("result1");
      // Standard write-action fields are still present
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

  it("read actions surface ABI-derived outputs as UI template suggestions", () => {
    for (const slug of [
      "get-user-supplied-assets",
      "get-user-debt",
      "get-reserve-id",
    ]) {
      const action = aaveV4Def.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" not found`).toBeDefined();
      if (!action) {
        continue;
      }
      expect(action.type).toBe("read");
      const pluginAction = protocolActionToPluginAction(aaveV4Def, action);
      const outputFieldNames = (pluginAction.outputFields ?? []).map(
        (f) => f.field
      );
      // success/error always present; plus at least one ABI-derived output
      expect(outputFieldNames).toEqual(
        expect.arrayContaining(["success", "error"])
      );
      expect(outputFieldNames).not.toContain("transactionHash");
      const nonStandardFields = outputFieldNames.filter(
        (f) => f !== "success" && f !== "error"
      );
      expect(nonStandardFields.length).toBeGreaterThan(0);
    }
  });

  it("get-user-account-data returns a single tuple output", () => {
    const action = aaveV4Def.actions.find(
      (a) => a.slug === "get-user-account-data"
    );
    expect(action).toBeDefined();
    expect(action?.type).toBe("read");
    expect(action?.function).toBe("getUserAccountData");
    expect(action?.inputs).toHaveLength(1);
    expect(action?.inputs[0].name).toBe("user");
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0].name).toBe("accountData");
    expect(action?.outputs?.[0].type).toBe("tuple");
  });

  it("set-collateral write has no outputs (Solidity returns void)", () => {
    const setCollateral = aaveV4Def.actions.find(
      (a) => a.slug === "set-collateral"
    );
    expect(setCollateral?.outputs).toBeUndefined();
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(aaveV4Def);
    const retrieved = getProtocol("aave-v4");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("aave-v4");
    expect(retrieved?.name).toBe("Aave V4");
  });
});
