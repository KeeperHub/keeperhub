import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import renzoDef from "@/protocols/renzo";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Renzo Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(renzoDef).toBeDefined();
    expect(renzoDef.name).toBe("Renzo");
    expect(renzoDef.slug).toBe("renzo");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(renzoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of renzoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(renzoDef.contracts));
    for (const action of renzoDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = renzoDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = renzoDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(renzoDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has two contracts (restakeManager, ezeth)", () => {
    expect(Object.keys(renzoDef.contracts).sort()).toEqual([
      "ezeth",
      "restakeManager",
    ]);
    expect(renzoDef.contracts.restakeManager.label).toBe(
      "Renzo Restake Manager"
    );
    expect(renzoDef.contracts.ezeth.label).toBe("ezETH Token");
  });

  it("has 4 actions: 1 write and 3 reads", () => {
    expect(renzoDef.actions).toHaveLength(4);
    const reads = renzoDef.actions.filter((a) => a.type === "read");
    const writes = renzoDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(3);
    expect(writes).toHaveLength(1);
  });

  it("exposes the expected action slugs", () => {
    const slugs = renzoDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(
      ["ez-balance-of", "ez-total-supply", "paused", "stake"].sort()
    );
  });

  it("stake is a payable write with no inputs on the RestakeManager", () => {
    const stake = renzoDef.actions.find((a) => a.slug === "stake");
    expect(stake).toBeDefined();
    expect(stake?.type).toBe("write");
    expect(stake?.payable).toBe(true);
    expect(stake?.inputs).toHaveLength(0);
    expect(stake?.contract).toBe("restakeManager");
    expect(stake?.function).toBe("depositETH");
    expect(stake?.label).toBe("Stake ETH for ezETH");
  });

  it("paused is a read returning a bool", () => {
    const paused = renzoDef.actions.find((a) => a.slug === "paused");
    expect(paused).toBeDefined();
    expect(paused?.type).toBe("read");
    expect(paused?.payable).toBeUndefined();
    expect(paused?.inputs).toHaveLength(0);
    expect(paused?.function).toBe("paused");
    expect(paused?.outputs).toHaveLength(1);
    expect(paused?.outputs?.[0].name).toBe("paused");
    expect(paused?.outputs?.[0].type).toBe("bool");
  });

  it("ez-total-supply reads an 18-decimal uint256 from ezETH", () => {
    const supply = renzoDef.actions.find((a) => a.slug === "ez-total-supply");
    expect(supply).toBeDefined();
    expect(supply?.type).toBe("read");
    expect(supply?.contract).toBe("ezeth");
    expect(supply?.function).toBe("totalSupply");
    expect(supply?.outputs?.[0].name).toBe("totalSupply");
    expect(supply?.outputs?.[0].type).toBe("uint256");
    expect(supply?.outputs?.[0].decimals).toBe(18);
  });

  it("ez-balance-of takes an address and returns a balance", () => {
    const bal = renzoDef.actions.find((a) => a.slug === "ez-balance-of");
    expect(bal).toBeDefined();
    expect(bal?.type).toBe("read");
    expect(bal?.contract).toBe("ezeth");
    expect(bal?.inputs).toHaveLength(1);
    expect(bal?.inputs[0].type).toBe("address");
    expect(bal?.outputs?.[0].name).toBe("balance");
    expect(bal?.outputs?.[0].decimals).toBe(18);
  });

  it("every contract is Ethereum mainnet only (chain 1)", () => {
    for (const contract of Object.values(renzoDef.contracts)) {
      expect(Object.keys(contract.addresses)).toEqual(["1"]);
    }
  });

  it("excludes Sepolia, Holesky, Goerli, Base and Arbitrum", () => {
    const excluded = ["11155111", "17000", "5", "8453", "42161"];
    for (const contract of Object.values(renzoDef.contracts)) {
      for (const chainId of excluded) {
        expect(
          contract.addresses[chainId],
          `contract must not be deployed on chain ${chainId}`
        ).toBeUndefined();
      }
    }
  });

  it("contract addresses match the verified mainnet deployments", () => {
    // Verified on-chain 2026-09-10: ezETH name/symbol, RestakeManager.paused()
    // false and renzoOracle() returning a live oracle address.
    expect(renzoDef.contracts.restakeManager.addresses["1"]).toBe(
      "0x74a09653A083691711cF8215a6ab074BB4e99ef5"
    );
    expect(renzoDef.contracts.ezeth.addresses["1"]).toBe(
      "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(renzoDef);
    const retrieved = getProtocol("renzo");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("renzo");
    expect(retrieved?.name).toBe("Renzo");
  });
});
