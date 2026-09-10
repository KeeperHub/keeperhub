import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import cbethDef from "@/protocols/coinbase-cbeth";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Coinbase cbETH Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(cbethDef).toBeDefined();
    expect(cbethDef.name).toBe("Coinbase cbETH");
    expect(cbethDef.slug).toBe("coinbase-cbeth");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(cbethDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of cbethDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(cbethDef.contracts));
    for (const action of cbethDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = cbethDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = cbethDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(cbethDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("is read-only: three reads, no writes", () => {
    expect(cbethDef.actions).toHaveLength(3);
    expect(cbethDef.actions.filter((a) => a.type === "read")).toHaveLength(3);
    expect(cbethDef.actions.filter((a) => a.type === "write")).toHaveLength(0);
    expect(cbethDef.actions.every((a) => a.payable === undefined)).toBe(true);
  });

  it("exposes exchange-rate, balance-of, total-supply", () => {
    const slugs = cbethDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(["balance-of", "exchange-rate", "total-supply"]);
  });

  it("exchange-rate returns an 18-decimal rate", () => {
    const rate = cbethDef.actions.find((a) => a.slug === "exchange-rate");
    expect(rate).toBeDefined();
    expect(rate?.type).toBe("read");
    expect(rate?.inputs).toHaveLength(0);
    expect(rate?.function).toBe("exchangeRate");
    expect(rate?.outputs?.[0].name).toBe("rate");
    expect(rate?.outputs?.[0].decimals).toBe(18);
  });

  it("balance-of takes an address and returns an 18-decimal balance", () => {
    const bal = cbethDef.actions.find((a) => a.slug === "balance-of");
    expect(bal).toBeDefined();
    expect(bal?.inputs).toHaveLength(1);
    expect(bal?.inputs[0].type).toBe("address");
    expect(bal?.outputs?.[0].name).toBe("balance");
    expect(bal?.outputs?.[0].decimals).toBe(18);
  });

  it("is Ethereum mainnet only (chain 1)", () => {
    expect(Object.keys(cbethDef.contracts.cbeth.addresses)).toEqual(["1"]);
  });

  it("cbETH address matches the verified mainnet deployment", () => {
    // Verified on-chain 2026-09-10: name "Coinbase Wrapped Staked ETH",
    // symbol cbETH, exchangeRate() ~1.1391e18.
    expect(cbethDef.contracts.cbeth.addresses["1"]).toBe(
      "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(cbethDef);
    const retrieved = getProtocol("coinbase-cbeth");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("coinbase-cbeth");
    expect(retrieved?.name).toBe("Coinbase cbETH");
  });
});
