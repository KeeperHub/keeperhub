import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import wrappedDef from "@/protocols/wrapped";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Wrapped Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(wrappedDef).toBeDefined();
    expect(wrappedDef.name).toBe("Wrapped");
    expect(wrappedDef.slug).toBe("wrapped");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(wrappedDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of wrappedDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(wrappedDef.contracts));
    for (const action of wrappedDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = wrappedDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = wrappedDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(wrappedDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has 3 actions (wrap, unwrap, balance-of)", () => {
    expect(wrappedDef.actions).toHaveLength(3);
    const slugs = wrappedDef.actions.map((a) => a.slug);
    expect(slugs).toContain("wrap");
    expect(slugs).toContain("unwrap");
    expect(slugs).toContain("balance-of");
  });

  it("has 2 write actions and 1 read action", () => {
    const reads = wrappedDef.actions.filter((a) => a.type === "read");
    const writes = wrappedDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(2);
  });

  it("has 1 contract", () => {
    expect(Object.keys(wrappedDef.contracts)).toHaveLength(1);
  });

  it("wrap action is payable with no inputs", () => {
    const wrap = wrappedDef.actions.find((a) => a.slug === "wrap");
    expect(wrap).toBeDefined();
    expect(wrap?.payable).toBe(true);
    expect(wrap?.inputs).toHaveLength(0);
    expect(wrap?.function).toBe("deposit");
    expect(wrap?.label).toBe("Wrap Native Token");
  });

  it("unwrap action has one uint256 input with helpTip and docUrl", () => {
    const unwrap = wrappedDef.actions.find((a) => a.slug === "unwrap");
    expect(unwrap).toBeDefined();
    expect(unwrap?.payable).toBeUndefined();
    expect(unwrap?.inputs).toHaveLength(1);
    expect(unwrap?.inputs[0].name).toBe("wad");
    expect(unwrap?.inputs[0].type).toBe("uint256");
    expect(unwrap?.inputs[0].label).toBe("Amount (wei)");
    expect(unwrap?.inputs[0].helpTip).toBeTruthy();
    expect(unwrap?.inputs[0].docUrl).toBe(
      "https://ethereum.org/en/wrapped-eth/"
    );
    expect(unwrap?.function).toBe("withdraw");
  });

  it("balance-of action has address input with helpTip/docUrl and uint256 output", () => {
    const balanceOf = wrappedDef.actions.find((a) => a.slug === "balance-of");
    expect(balanceOf).toBeDefined();
    expect(balanceOf?.type).toBe("read");
    expect(balanceOf?.inputs).toHaveLength(1);
    expect(balanceOf?.inputs[0].name).toBe("account");
    expect(balanceOf?.inputs[0].type).toBe("address");
    expect(balanceOf?.inputs[0].label).toBe("Wallet Address");
    expect(balanceOf?.inputs[0].helpTip).toBeTruthy();
    expect(balanceOf?.inputs[0].docUrl).toBe(
      "https://ethereum.org/en/wrapped-eth/"
    );
    expect(balanceOf?.outputs).toHaveLength(1);
    expect(balanceOf?.outputs?.[0].name).toBe("balance");
    expect(balanceOf?.outputs?.[0].label).toBe("Wrapped Token Balance (wei)");
    expect(balanceOf?.outputs?.[0].decimals).toBe(18);
    expect(balanceOf?.function).toBe("balanceOf");
  });

  it("wrapped contract is available on all supported EVM chains with canonical addresses", () => {
    const chains = Object.keys(wrappedDef.contracts.weth.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("11155111");
    expect(chains).toContain("84532");
    expect(chains).toContain("421614");
    expect(chains).toContain("56");
    expect(chains).toContain("97");
    expect(chains).toContain("137");
    expect(chains).toContain("43114");
    expect(chains).toContain("43113");
    expect(chains).not.toContain("10");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(wrappedDef);
    const retrieved = getProtocol("wrapped");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("wrapped");
    expect(retrieved?.name).toBe("Wrapped");
  });
});
