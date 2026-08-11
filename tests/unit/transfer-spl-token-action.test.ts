import { describe, expect, it } from "vitest";
import type { ActionConfigField } from "@/plugins/registry";
import { findActionById } from "@/plugins/registry";

/**
 * Guards the non-obvious constraints in the Transfer SPL Token action
 * definition. Each assertion protects against a specific, silent breakage - the
 * file:line references are why these are not arbitrary.
 */
describe("web3/transfer-spl-token action definition", () => {
  const action = findActionById("web3/transfer-spl-token");

  function flatFields(): ActionConfigField[] {
    const fields = action?.configFields ?? [];
    return fields.flatMap((field) =>
      field.type === "group" ? [field, ...field.fields] : [field]
    );
  }

  function fieldByKey(key: string) {
    return flatFields().find((field) => "key" in field && field.key === key);
  }

  it("is registered and discoverable in the action registry", () => {
    expect(action).toBeDefined();
    expect(action?.label).toBe("Transfer SPL Token");
    // category drives grouping in the node palette (action-grid.tsx).
    expect(action?.category).toBe("Web3");
  });

  it("restricts the Network field to Solana chains", () => {
    // chain-select-field.tsx filters /api/chains by chain.chainType. The value is
    // an unvalidated loose string: a typo silently yields an empty dropdown with
    // no error, and nothing else in the suite asserts it.
    const network = fieldByKey("network");
    expect(network).toMatchObject({
      type: "chain-select",
      chainTypeFilter: "solana",
    });
  });

  it("does not key the mint field so it ends in 'address'", () => {
    // action-config-renderer.tsx treats any key ending in "address" as an EVM
    // address: it applies toChecksumAddress() to the displayed value and attaches
    // the Ethereum-only address book, whose Save button rejects base58 with
    // "Please enter a valid Ethereum address first".
    expect(fieldByKey("mint")).toBeDefined();
    for (const field of flatFields()) {
      if ("key" in field && field.key !== "recipientAddress") {
        expect(field.key.toLowerCase().endsWith("address")).toBe(false);
      }
    }
  });

  it("never declares isAddressField", () => {
    // action-config.ts validates declared address fields against
    // ETH_ADDRESS_PATTERN, which rejects every valid base58 Solana address.
    for (const field of flatFields()) {
      expect("isAddressField" in field && field.isAddressField).toBeFalsy();
    }
  });

  it("declares no EVM-only fields", () => {
    for (const field of flatFields()) {
      // gas-limit-multiplier posts to /api/gas/estimate with an EVM chainId, and
      // Solana fees are lamports-per-signature plus optional priority fees.
      expect(field.type).not.toBe("gas-limit-multiplier");
      // showPrivateVariants renders private-mempool chain variants; Solana has none.
      expect(
        "showPrivateVariants" in field && field.showPrivateVariants
      ).toBeFalsy();
      // token-select is EVM-bound end to end: it checksums addresses, dedupes
      // case-insensitively (base58 is case-sensitive), and validates via
      // /api/validate-token, which is ethers.isAddress + ERC20 ABI.
      expect(field.type).not.toBe("token-select");
    }
  });

  it("points at the step function and import path the bundler expects", () => {
    expect(action).toMatchObject({
      stepFunction: "transferSplTokenStep",
      stepImportPath: "transfer-spl-token",
    });
  });
});
