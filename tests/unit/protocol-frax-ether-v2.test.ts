import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import fraxEtherV2Def from "@/protocols/frax-ether-v2";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Frax Ether V2 Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(fraxEtherV2Def).toBeDefined();
    expect(fraxEtherV2Def.name).toBe("Frax Ether V2");
    expect(fraxEtherV2Def.slug).toBe("frax-ether-v2");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(fraxEtherV2Def.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of fraxEtherV2Def.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(fraxEtherV2Def.contracts));
    for (const action of fraxEtherV2Def.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = fraxEtherV2Def.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = fraxEtherV2Def.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(fraxEtherV2Def.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has 4 actions (mint, mint-and-give, mint-and-stake, mint-paused)", () => {
    expect(fraxEtherV2Def.actions).toHaveLength(4);
    const slugs = fraxEtherV2Def.actions.map((a) => a.slug);
    expect(slugs).toContain("mint");
    expect(slugs).toContain("mint-and-give");
    expect(slugs).toContain("mint-and-stake");
    expect(slugs).toContain("mint-paused");
  });

  it("has 3 write actions and 1 read action", () => {
    const reads = fraxEtherV2Def.actions.filter((a) => a.type === "read");
    const writes = fraxEtherV2Def.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(3);
  });

  it("has 1 contract (minter)", () => {
    expect(Object.keys(fraxEtherV2Def.contracts)).toHaveLength(1);
    expect(fraxEtherV2Def.contracts.minter).toBeDefined();
    expect(fraxEtherV2Def.contracts.minter.label).toBe("Frax Ether Minter V2");
  });

  it("mint action is payable with no inputs", () => {
    const mint = fraxEtherV2Def.actions.find((a) => a.slug === "mint");
    expect(mint).toBeDefined();
    expect(mint?.payable).toBe(true);
    expect(mint?.inputs).toHaveLength(0);
    expect(mint?.function).toBe("mintFrxEth");
    expect(mint?.label).toBe("Mint frxETH");
    expect(mint?.type).toBe("write");
  });

  it("mint-and-give action has one address input with helpTip and docUrl", () => {
    const mintAndGive = fraxEtherV2Def.actions.find(
      (a) => a.slug === "mint-and-give"
    );
    expect(mintAndGive).toBeDefined();
    expect(mintAndGive?.payable).toBe(true);
    expect(mintAndGive?.inputs).toHaveLength(1);
    expect(mintAndGive?.inputs[0].name).toBe("recipient");
    expect(mintAndGive?.inputs[0].type).toBe("address");
    expect(mintAndGive?.inputs[0].label).toBe("Recipient Address");
    expect(mintAndGive?.inputs[0].helpTip).toBeTruthy();
    expect(mintAndGive?.inputs[0].docUrl).toBe(
      "https://docs.frax.finance/frax-ether/frxeth-and-sfrxeth"
    );
    expect(mintAndGive?.function).toBe("mintFrxEthAndGive");
  });

  it("mint-and-stake action has address input and uint256 shares output with 18 decimals", () => {
    const mintAndStake = fraxEtherV2Def.actions.find(
      (a) => a.slug === "mint-and-stake"
    );
    expect(mintAndStake).toBeDefined();
    expect(mintAndStake?.payable).toBe(true);
    expect(mintAndStake?.inputs).toHaveLength(1);
    expect(mintAndStake?.inputs[0].name).toBe("recipient");
    expect(mintAndStake?.inputs[0].type).toBe("address");
    expect(mintAndStake?.outputs).toHaveLength(1);
    expect(mintAndStake?.outputs?.[0].name).toBe("shares");
    expect(mintAndStake?.outputs?.[0].type).toBe("uint256");
    expect(mintAndStake?.outputs?.[0].label).toBe(
      "sfrxETH Shares Received (wei)"
    );
    expect(mintAndStake?.outputs?.[0].decimals).toBe(18);
    expect(mintAndStake?.function).toBe("submitAndDeposit");
  });

  it("mint-paused is a read action returning a bool", () => {
    const mintPaused = fraxEtherV2Def.actions.find(
      (a) => a.slug === "mint-paused"
    );
    expect(mintPaused).toBeDefined();
    expect(mintPaused?.type).toBe("read");
    expect(mintPaused?.payable).toBeUndefined();
    expect(mintPaused?.inputs).toHaveLength(0);
    expect(mintPaused?.outputs).toHaveLength(1);
    expect(mintPaused?.outputs?.[0].name).toBe("paused");
    expect(mintPaused?.outputs?.[0].type).toBe("bool");
    expect(mintPaused?.outputs?.[0].label).toBe("Mint Paused");
    expect(mintPaused?.function).toBe("mintFrxEthPaused");
  });

  it("minter contract is deployed on Ethereum mainnet only (chain 1)", () => {
    const chains = Object.keys(fraxEtherV2Def.contracts.minter.addresses);
    expect(chains).toEqual(["1"]);
  });

  it("minter contract address matches the verified V2 deployment", () => {
    expect(fraxEtherV2Def.contracts.minter.addresses["1"]).toBe(
      "0x7Bc6bad540453360F744666D625fec0ee1320cA3"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(fraxEtherV2Def);
    const retrieved = getProtocol("frax-ether-v2");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("frax-ether-v2");
    expect(retrieved?.name).toBe("Frax Ether V2");
  });
});
