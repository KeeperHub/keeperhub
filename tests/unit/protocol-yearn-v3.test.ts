import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import yearnV3Def from "@/protocols/yearn-v3";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Yearn V3 Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(yearnV3Def).toBeDefined();
    expect(yearnV3Def.name).toBe("Yearn V3");
    expect(yearnV3Def.slug).toBe("yearn");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(yearnV3Def.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of yearnV3Def.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      yearnV3Def.contracts
    )) {
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
    const contractKeys = new Set(Object.keys(yearnV3Def.contracts));
    for (const action of yearnV3Def.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = yearnV3Def.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = yearnV3Def.actions.filter((a) => a.type === "read");
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
    for (const action of yearnV3Def.actions) {
      const contract = yearnV3Def.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 31 actions (18 ERC-4626 + 13 Yearn-specific)", () => {
    expect(yearnV3Def.actions).toHaveLength(31);
  });

  it("has 27 read actions and 4 write actions", () => {
    const readActions = yearnV3Def.actions.filter((a) => a.type === "read");
    const writeActions = yearnV3Def.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(27);
    expect(writeActions).toHaveLength(4);
  });

  it("has 1 contract (vault with user-specified address)", () => {
    expect(Object.keys(yearnV3Def.contracts)).toHaveLength(1);
    expect(yearnV3Def.contracts.vault.userSpecifiedAddress).toBe(true);
  });

  it("vault contract is available on 3 chains", () => {
    const chains = Object.keys(yearnV3Def.contracts.vault.addresses);
    expect(chains).toHaveLength(3);
    expect(yearnV3Def.contracts.vault.addresses["1"]).toBeDefined();
    expect(yearnV3Def.contracts.vault.addresses["137"]).toBeDefined();
    expect(yearnV3Def.contracts.vault.addresses["42161"]).toBeDefined();
  });

  it("vault contract has an inline ABI (required for EIP-1167 proxies)", () => {
    expect(yearnV3Def.contracts.vault.abi).toBeDefined();
    const parsed = JSON.parse(yearnV3Def.contracts.vault.abi ?? "[]");
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("inline ABI includes all ERC-4626 functions", () => {
    const parsed = JSON.parse(yearnV3Def.contracts.vault.abi ?? "[]");
    const fnNames = parsed.map((f: { name: string }) => f.name);
    const erc4626Functions = [
      "deposit",
      "withdraw",
      "redeem",
      "asset",
      "totalAssets",
      "totalSupply",
      "balanceOf",
      "convertToAssets",
      "convertToShares",
      "previewDeposit",
      "previewRedeem",
      "maxDeposit",
      "maxWithdraw",
    ];
    for (const fn of erc4626Functions) {
      expect(fnNames, `ABI should include ${fn}`).toContain(fn);
    }
  });

  it("inline ABI includes Yearn-specific functions", () => {
    const parsed = JSON.parse(yearnV3Def.contracts.vault.abi ?? "[]");
    const fnNames = parsed.map((f: { name: string }) => f.name);
    const yearnFunctions = [
      "pricePerShare",
      "totalIdle",
      "totalDebt",
      "isShutdown",
      "apiVersion",
      "profitMaxUnlockTime",
      "fullProfitUnlockDate",
      "accountant",
      "deposit_limit",
      "role_manager",
      "use_default_queue",
      "minimum_total_idle",
      "decimals",
    ];
    for (const fn of yearnFunctions) {
      expect(fnNames, `ABI should include ${fn}`).toContain(fn);
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(yearnV3Def);
    const retrieved = getProtocol("yearn");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("yearn");
    expect(retrieved?.name).toBe("Yearn V3");
  });

  it("includes Yearn-specific read actions", () => {
    const yearnSlugs = [
      "get-price-per-share",
      "get-total-idle",
      "get-total-debt",
      "get-is-shutdown",
      "get-api-version",
      "get-profit-max-unlock-time",
      "get-full-profit-unlock-date",
      "get-accountant",
      "get-deposit-limit",
    ];
    const actionSlugs = yearnV3Def.actions.map((a) => a.slug);
    for (const slug of yearnSlugs) {
      expect(actionSlugs, `should include action "${slug}"`).toContain(slug);
    }
  });

  it("includes standard ERC-4626 vault actions", () => {
    const erc4626Slugs = [
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
    const actionSlugs = yearnV3Def.actions.map((a) => a.slug);
    for (const slug of erc4626Slugs) {
      expect(actionSlugs, `should include action "${slug}"`).toContain(slug);
    }
  });

  it("has website and icon metadata", () => {
    expect(yearnV3Def.website).toBe("https://yearn.fi");
    expect(yearnV3Def.icon).toBe("/protocols/yearn.png");
  });
});
