import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import etherFiDef from "@/protocols/ether-fi";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("ether.fi Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(etherFiDef).toBeDefined();
    expect(etherFiDef.name).toBe("ether.fi");
    expect(etherFiDef.slug).toBe("ether-fi");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(etherFiDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of etherFiDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(etherFiDef.contracts));
    for (const action of etherFiDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = etherFiDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = etherFiDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(etherFiDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has three contracts (liquidityPool, weeth, eeth)", () => {
    expect(Object.keys(etherFiDef.contracts).sort()).toEqual([
      "eeth",
      "liquidityPool",
      "weeth",
    ]);
    expect(etherFiDef.contracts.liquidityPool.label).toBe(
      "ether.fi Liquidity Pool"
    );
    expect(etherFiDef.contracts.weeth.label).toBe("weETH Token");
    expect(etherFiDef.contracts.eeth.label).toBe("eETH Token");
  });

  it("has 13 actions: 3 writes and 10 reads", () => {
    expect(etherFiDef.actions).toHaveLength(13);
    const reads = etherFiDef.actions.filter((a) => a.type === "read");
    const writes = etherFiDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(10);
    expect(writes).toHaveLength(3);
  });

  it("exposes the expected action slugs", () => {
    const slugs = etherFiDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(
      [
        "amount-for-share",
        "eeth-balance-of",
        "eeth-total-shares",
        "get-eeth-by-weeth",
        "get-rate",
        "get-total-pooled-ether",
        "get-weeth-by-eeth",
        "shares-for-amount",
        "stake",
        "unwrap",
        "weeth-balance-of",
        "weeth-total-supply",
        "wrap",
      ].sort()
    );
  });

  it("stake is a payable write with no inputs and a uint256 output", () => {
    const stake = etherFiDef.actions.find((a) => a.slug === "stake");
    expect(stake).toBeDefined();
    expect(stake?.type).toBe("write");
    expect(stake?.payable).toBe(true);
    expect(stake?.inputs).toHaveLength(0);
    expect(stake?.contract).toBe("liquidityPool");
    expect(stake?.function).toBe("deposit");
    expect(stake?.label).toBe("Stake ETH for eETH");
    expect(stake?.outputs).toHaveLength(1);
    expect(stake?.outputs?.[0].type).toBe("uint256");
  });

  it("wrap is a non-payable write with one uint256 input and output", () => {
    const wrap = etherFiDef.actions.find((a) => a.slug === "wrap");
    expect(wrap).toBeDefined();
    expect(wrap?.type).toBe("write");
    expect(wrap?.payable).toBeUndefined();
    expect(wrap?.contract).toBe("weeth");
    expect(wrap?.function).toBe("wrap");
    expect(wrap?.inputs).toHaveLength(1);
    expect(wrap?.inputs[0].name).toBe("amount");
    expect(wrap?.inputs[0].type).toBe("uint256");
    expect(wrap?.inputs[0].decimals).toBe(18);
    expect(wrap?.inputs[0].helpTip).toBeTruthy();
    expect(wrap?.outputs?.[0].name).toBe("weETHReceived");
    expect(wrap?.outputs?.[0].decimals).toBe(18);
  });

  it("unwrap is a non-payable write returning eETH", () => {
    const unwrap = etherFiDef.actions.find((a) => a.slug === "unwrap");
    expect(unwrap).toBeDefined();
    expect(unwrap?.type).toBe("write");
    expect(unwrap?.payable).toBeUndefined();
    expect(unwrap?.contract).toBe("weeth");
    expect(unwrap?.function).toBe("unwrap");
    expect(unwrap?.inputs).toHaveLength(1);
    expect(unwrap?.outputs?.[0].name).toBe("eETHReceived");
  });

  it("get-rate is a read returning an 18-decimal rate", () => {
    const getRate = etherFiDef.actions.find((a) => a.slug === "get-rate");
    expect(getRate).toBeDefined();
    expect(getRate?.type).toBe("read");
    expect(getRate?.payable).toBeUndefined();
    expect(getRate?.inputs).toHaveLength(0);
    expect(getRate?.function).toBe("getRate");
    expect(getRate?.outputs?.[0].name).toBe("rate");
    expect(getRate?.outputs?.[0].decimals).toBe(18);
  });

  it("eeth-total-shares reads from the eETH contract", () => {
    const shares = etherFiDef.actions.find(
      (a) => a.slug === "eeth-total-shares"
    );
    expect(shares).toBeDefined();
    expect(shares?.type).toBe("read");
    expect(shares?.contract).toBe("eeth");
    expect(shares?.function).toBe("totalShares");
    expect(shares?.outputs?.[0].name).toBe("totalShares");
  });

  it("every contract is Ethereum mainnet only (chain 1)", () => {
    for (const contract of Object.values(etherFiDef.contracts)) {
      expect(Object.keys(contract.addresses)).toEqual(["1"]);
    }
  });

  it("contract addresses match the verified mainnet deployments", () => {
    // Verified on-chain 2026-09-10: name/symbol/decimals plus weETH.eETH()
    // linking to the eETH address, and weETH.getRate() equal to the pool's
    // amountForShare(1e18).
    expect(etherFiDef.contracts.liquidityPool.addresses["1"]).toBe(
      "0x308861A430be4cce5502d0A12724771Fc6DaF216"
    );
    expect(etherFiDef.contracts.weeth.addresses["1"]).toBe(
      "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee"
    );
    expect(etherFiDef.contracts.eeth.addresses["1"]).toBe(
      "0x35fA164735182de50811E8e2E824cFb9B6118ac2"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(etherFiDef);
    const retrieved = getProtocol("ether-fi");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("ether-fi");
    expect(retrieved?.name).toBe("ether.fi");
  });
});
