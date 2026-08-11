import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import ethenaDef from "@/protocols/ethena";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Ethena Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(ethenaDef).toBeDefined();
    expect(ethenaDef.name).toBe("Ethena");
    expect(ethenaDef.slug).toBe("ethena");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(ethenaDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of ethenaDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(ethenaDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(address, `${contractKey} on chain ${chain}`).toMatch(
          HEX_ADDRESS_REGEX
        );
        expect(address, `${contractKey} on chain ${chain} length`).toHaveLength(
          42
        );
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(ethenaDef.contracts));
    for (const action of ethenaDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = ethenaDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = ethenaDef.actions.filter((a) => a.type === "read");
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
    for (const action of ethenaDef.actions) {
      const contract = ethenaDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has 3 contracts: sUsde, usde, ena", () => {
    const keys = Object.keys(ethenaDef.contracts);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("sUsde");
    expect(keys).toContain("usde");
    expect(keys).toContain("ena");
  });

  it("all contracts are Ethereum-only", () => {
    for (const [key, contract] of Object.entries(ethenaDef.contracts)) {
      const chains = Object.keys(contract.addresses);
      expect(chains, `contract "${key}" should be Ethereum-only`).toEqual([
        "1",
      ]);
    }
  });

  it("has correct contract addresses", () => {
    expect(ethenaDef.contracts.sUsde.addresses["1"]).toBe(
      "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497"
    );
    expect(ethenaDef.contracts.usde.addresses["1"]).toBe(
      "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3"
    );
    expect(ethenaDef.contracts.ena.addresses["1"]).toBe(
      "0x57e114B691Db790C35207b2e685D4A43181e6061"
    );
  });

  it("has exactly 26 actions (18 ERC-4626 + 5 cooldown + 2 token balance + 1 approval)", () => {
    expect(ethenaDef.actions).toHaveLength(26);
  });

  it("has 18 read actions and 8 write actions", () => {
    const readActions = ethenaDef.actions.filter((a) => a.type === "read");
    const writeActions = ethenaDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(18);
    expect(writeActions).toHaveLength(8);
  });

  it("includes standard ERC-4626 vault actions on sUsde", () => {
    const vaultSlugs = [
      "vault-deposit",
      "vault-withdraw",
      "vault-redeem",
      "vault-asset",
      "vault-total-assets",
      "vault-total-supply",
      "vault-balance",
      "vault-convert-to-assets",
      "vault-convert-to-shares",
      "vault-preview-deposit",
      "vault-preview-redeem",
      "vault-max-deposit",
      "vault-max-withdraw",
    ];
    for (const slug of vaultSlugs) {
      const action = ethenaDef.actions.find((a) => a.slug === slug);
      expect(action, `missing ERC-4626 action "${slug}"`).toBeDefined();
      expect(action?.contract).toBe("sUsde");
    }
  });

  it("includes cooldown management actions", () => {
    const cooldownActions = [
      "cooldown-assets",
      "cooldown-shares",
      "unstake",
      "get-cooldown-duration",
      "get-cooldown-status",
    ];
    for (const slug of cooldownActions) {
      const action = ethenaDef.actions.find((a) => a.slug === slug);
      expect(action, `missing cooldown action "${slug}"`).toBeDefined();
      expect(action?.contract).toBe("sUsde");
    }
  });

  it("cooldown-duration is a read action with output", () => {
    const action = ethenaDef.actions.find(
      (a) => a.slug === "get-cooldown-duration"
    );
    expect(action).toBeDefined();
    expect(action?.type).toBe("read");
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("cooldownDuration");
  });

  it("cooldown-status returns two outputs", () => {
    const action = ethenaDef.actions.find(
      (a) => a.slug === "get-cooldown-status"
    );
    expect(action).toBeDefined();
    expect(action?.type).toBe("read");
    expect(action?.outputs).toHaveLength(2);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("cooldownEnd");
    expect(outputNames).toContain("underlyingAmount");
  });

  it("includes token balance actions for USDe and ENA", () => {
    const usdeBalance = ethenaDef.actions.find(
      (a) => a.slug === "get-usde-balance"
    );
    expect(usdeBalance).toBeDefined();
    expect(usdeBalance?.contract).toBe("usde");
    expect(usdeBalance?.type).toBe("read");

    const enaBalance = ethenaDef.actions.find(
      (a) => a.slug === "get-ena-balance"
    );
    expect(enaBalance).toBeDefined();
    expect(enaBalance?.contract).toBe("ena");
    expect(enaBalance?.type).toBe("read");
  });

  it("includes USDe approval action", () => {
    const action = ethenaDef.actions.find((a) => a.slug === "approve-usde");
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("usde");
    expect(action?.function).toBe("approve");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(ethenaDef);
    const retrieved = getProtocol("ethena");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("ethena");
    expect(retrieved?.name).toBe("Ethena");
  });
});
