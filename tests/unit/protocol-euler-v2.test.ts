import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import eulerV2Def from "@/protocols/euler-v2";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Euler V2 Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(eulerV2Def).toBeDefined();
    expect(eulerV2Def.name).toBe("Euler V2");
    expect(eulerV2Def.slug).toBe("euler-v2");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(eulerV2Def.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of eulerV2Def.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      eulerV2Def.contracts
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
    const contractKeys = new Set(Object.keys(eulerV2Def.contracts));
    for (const action of eulerV2Def.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = eulerV2Def.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = eulerV2Def.actions.filter((a) => a.type === "read");
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
    for (const action of eulerV2Def.actions) {
      const contract = eulerV2Def.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 29 actions (18 ERC-4626 + 11 Euler-specific)", () => {
    expect(eulerV2Def.actions).toHaveLength(29);
  });

  it("has 25 read actions and 4 write actions", () => {
    const readActions = eulerV2Def.actions.filter((a) => a.type === "read");
    const writeActions = eulerV2Def.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(25);
    expect(writeActions).toHaveLength(4);
  });

  it("has 1 contract (vault with user-specified address)", () => {
    expect(Object.keys(eulerV2Def.contracts)).toHaveLength(1);
    expect(eulerV2Def.contracts.vault.userSpecifiedAddress).toBe(true);
  });

  it("vault contract is available on 2 chains", () => {
    const chains = Object.keys(eulerV2Def.contracts.vault.addresses);
    expect(chains).toHaveLength(2);
    expect(eulerV2Def.contracts.vault.addresses["1"]).toBeDefined();
    expect(eulerV2Def.contracts.vault.addresses["8453"]).toBeDefined();
  });

  it("vault contract has an inline ABI (required for EVK module proxies)", () => {
    expect(eulerV2Def.contracts.vault.abi).toBeDefined();
    const parsed = JSON.parse(eulerV2Def.contracts.vault.abi ?? "[]");
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("inline ABI includes all ERC-4626 functions", () => {
    const parsed = JSON.parse(eulerV2Def.contracts.vault.abi ?? "[]");
    const fnNames = parsed.map((f: { name: string }) => f.name);
    const erc4626Functions = [
      "deposit",
      "mint",
      "withdraw",
      "redeem",
      "asset",
      "totalAssets",
      "totalSupply",
      "balanceOf",
      "convertToAssets",
      "convertToShares",
      "previewDeposit",
      "previewMint",
      "previewWithdraw",
      "previewRedeem",
      "maxDeposit",
      "maxMint",
      "maxWithdraw",
      "maxRedeem",
    ];
    for (const fn of erc4626Functions) {
      expect(fnNames, `ABI should include ${fn}`).toContain(fn);
    }
  });

  it("inline ABI includes Euler-specific functions", () => {
    const parsed = JSON.parse(eulerV2Def.contracts.vault.abi ?? "[]");
    const fnNames = parsed.map((f: { name: string }) => f.name);
    const eulerFunctions = [
      "cash",
      "totalBorrows",
      "interestRate",
      "interestAccumulator",
      "accumulatedFees",
      "debtOf",
      "oracle",
      "unitOfAccount",
      "EVC",
      "creator",
      "decimals",
    ];
    for (const fn of eulerFunctions) {
      expect(fnNames, `ABI should include ${fn}`).toContain(fn);
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(eulerV2Def);
    const retrieved = getProtocol("euler-v2");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("euler-v2");
    expect(retrieved?.name).toBe("Euler V2");
  });

  it("includes Euler-specific read actions", () => {
    const eulerSlugs = [
      "get-cash",
      "get-total-borrows",
      "get-interest-rate",
      "get-interest-accumulator",
      "get-accumulated-fees",
      "get-debt-of",
      "get-oracle",
      "get-unit-of-account",
      "get-evc",
      "get-creator",
      "get-vault-decimals",
    ];
    const actionSlugs = eulerV2Def.actions.map((a) => a.slug);
    for (const slug of eulerSlugs) {
      expect(actionSlugs, `should include action "${slug}"`).toContain(slug);
    }
  });

  it("includes standard ERC-4626 vault actions", () => {
    const erc4626Slugs = [
      "vault-deposit",
      "vault-mint",
      "vault-withdraw",
      "vault-redeem",
      "vault-asset",
      "vault-total-assets",
      "vault-total-supply",
      "vault-balance",
      "vault-convert-to-assets",
      "vault-convert-to-shares",
      "vault-preview-deposit",
      "vault-preview-mint",
      "vault-preview-withdraw",
      "vault-preview-redeem",
      "vault-max-deposit",
      "vault-max-mint",
      "vault-max-withdraw",
      "vault-max-redeem",
    ];
    const actionSlugs = eulerV2Def.actions.map((a) => a.slug);
    for (const slug of erc4626Slugs) {
      expect(actionSlugs, `should include action "${slug}"`).toContain(slug);
    }
  });

  it("write actions name their amount input assets or shares", () => {
    // erc4626AbiOverrides keys its input overrides by `assets` and `shares`, and
    // deriveAction looks overrides up by the ABI parameter's own name. An ABI
    // that names the first write parameter anything else (Euler's own source
    // calls it `amount`) drops the binding silently: the action renders a
    // generic Amount field, the docs name a key that does not exist, and test
    // data binds nothing, so the encoded amount falls through to the uint
    // default of 1.
    const expected: Record<string, string> = {
      "vault-deposit": "assets",
      "vault-mint": "shares",
      "vault-withdraw": "assets",
      "vault-redeem": "shares",
    };
    const parsed = JSON.parse(eulerV2Def.contracts.vault.abi ?? "[]") as {
      name: string;
      inputs?: { name: string }[];
    }[];
    const abiFn = (n: string) => parsed.find((f) => f.name === n);
    for (const [slug, inputName] of Object.entries(expected)) {
      const action = eulerV2Def.actions.find((a) => a.slug === slug);
      expect(action, `missing action ${slug}`).toBeDefined();
      const fn = abiFn(slug.replace("vault-", ""));
      expect(fn, `missing ABI entry for ${slug}`).toBeDefined();
      expect(
        fn?.inputs?.[0]?.name,
        `${slug} first ABI input must be named "${inputName}" or the override binding is dropped`
      ).toBe(inputName);
    }
  });

  it("has website and icon metadata", () => {
    expect(eulerV2Def.website).toBe("https://euler.finance");
    expect(eulerV2Def.icon).toBe("/protocols/euler-v2.png");
  });
});
