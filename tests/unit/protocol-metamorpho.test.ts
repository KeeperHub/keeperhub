import { describe, expect, it } from "vitest";
import {
  getProtocol,
  registerProtocol,
} from "@/keeperhub/lib/protocol-registry";
import metamorphoDef from "@/keeperhub/protocols/metamorpho";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

describe("MetaMorpho Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(metamorphoDef).toBeDefined();
    expect(metamorphoDef.name).toBe("MetaMorpho");
    expect(metamorphoDef.slug).toBe("metamorpho");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(metamorphoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("has correct metadata", () => {
    expect(metamorphoDef.website).toBe("https://app.morpho.org");
    expect(metamorphoDef.icon).toBe("/protocols/metamorpho.png");
    expect(metamorphoDef.description).toContain("MetaMorpho");
    expect(metamorphoDef.description).toContain("ERC-4626");
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of metamorphoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("vault contract uses userSpecifiedAddress", () => {
    const vault = metamorphoDef.contracts.vault;
    expect(vault).toBeDefined();
    expect(vault.userSpecifiedAddress).toBe(true);
    expect(Object.keys(vault.addresses)).toHaveLength(0);
  });

  it("every action references the vault contract", () => {
    for (const action of metamorphoDef.actions) {
      expect(
        action.contract,
        `action "${action.slug}" must reference the vault contract`
      ).toBe("vault");
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = metamorphoDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = metamorphoDef.actions.filter((a) => a.type === "read");
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

  it("has exactly 13 actions (standard ERC-4626)", () => {
    expect(metamorphoDef.actions).toHaveLength(13);
  });

  it("has 1 contract", () => {
    expect(Object.keys(metamorphoDef.contracts)).toHaveLength(1);
  });

  it("has 3 write actions and 10 read actions", () => {
    const readActions = metamorphoDef.actions.filter((a) => a.type === "read");
    const writeActions = metamorphoDef.actions.filter(
      (a) => a.type === "write"
    );
    expect(readActions).toHaveLength(10);
    expect(writeActions).toHaveLength(3);
  });

  it("has the standard ERC-4626 write actions", () => {
    const writeSlugs = metamorphoDef.actions
      .filter((a) => a.type === "write")
      .map((a) => a.slug);
    expect(writeSlugs).toContain("vault-deposit");
    expect(writeSlugs).toContain("vault-withdraw");
    expect(writeSlugs).toContain("vault-redeem");
  });

  it("has the standard ERC-4626 read actions", () => {
    const readSlugs = metamorphoDef.actions
      .filter((a) => a.type === "read")
      .map((a) => a.slug);
    expect(readSlugs).toContain("vault-asset");
    expect(readSlugs).toContain("vault-total-assets");
    expect(readSlugs).toContain("vault-total-supply");
    expect(readSlugs).toContain("vault-balance");
    expect(readSlugs).toContain("vault-convert-to-assets");
    expect(readSlugs).toContain("vault-convert-to-shares");
    expect(readSlugs).toContain("vault-preview-deposit");
    expect(readSlugs).toContain("vault-preview-redeem");
    expect(readSlugs).toContain("vault-max-deposit");
    expect(readSlugs).toContain("vault-max-withdraw");
  });

  it("deposit action has correct inputs", () => {
    const deposit = metamorphoDef.actions.find(
      (a) => a.slug === "vault-deposit"
    );
    expect(deposit).toBeDefined();
    expect(deposit?.inputs).toHaveLength(2);
    expect(deposit?.inputs[0].name).toBe("assets");
    expect(deposit?.inputs[1].name).toBe("receiver");
  });

  it("withdraw action has correct inputs", () => {
    const withdraw = metamorphoDef.actions.find(
      (a) => a.slug === "vault-withdraw"
    );
    expect(withdraw).toBeDefined();
    expect(withdraw?.inputs).toHaveLength(3);
    expect(withdraw?.inputs[0].name).toBe("assets");
    expect(withdraw?.inputs[1].name).toBe("receiver");
    expect(withdraw?.inputs[2].name).toBe("owner");
  });

  it("redeem action has correct inputs", () => {
    const redeem = metamorphoDef.actions.find((a) => a.slug === "vault-redeem");
    expect(redeem).toBeDefined();
    expect(redeem?.inputs).toHaveLength(3);
    expect(redeem?.inputs[0].name).toBe("shares");
    expect(redeem?.inputs[1].name).toBe("receiver");
    expect(redeem?.inputs[2].name).toBe("owner");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(metamorphoDef);
    const retrieved = getProtocol("metamorpho");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("metamorpho");
    expect(retrieved?.name).toBe("MetaMorpho");
  });
});
