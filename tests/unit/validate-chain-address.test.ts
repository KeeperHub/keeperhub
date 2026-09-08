import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evmOnlyGuard,
  validateChainAddress,
  validateChainTxHash,
} from "@/lib/web3/validate-chain-address";

const EVM_CHAIN_ID = 1;
const SOLANA_CHAIN_ID = 101;

const VALID_EVM_ADDRESS = "0x9464020b645A9206a12b19f7c1155966BE4f4aAE";
const VALID_SOLANA_ADDRESS = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";
const VALID_EVM_TX_HASH =
  "0x72edaf73d90ecd9f4fa701e5c16de7ecd6df1e05b3df7240e1a1ea70a44557e8";
const VALID_SOLANA_SIGNATURE =
  "4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwUa7vjaXK5VhDF7ZiiF16v7cY5BPazCLnVqZ3yzb";

describe("validateChainAddress", () => {
  it("accepts a valid EVM address on an EVM chain", () => {
    expect(validateChainAddress(VALID_EVM_ADDRESS, EVM_CHAIN_ID)).toBe(true);
  });

  it("rejects a Solana address on an EVM chain", () => {
    expect(validateChainAddress(VALID_SOLANA_ADDRESS, EVM_CHAIN_ID)).toBe(
      false
    );
  });

  it("accepts a valid Solana address on a Solana chain", () => {
    expect(validateChainAddress(VALID_SOLANA_ADDRESS, SOLANA_CHAIN_ID)).toBe(
      true
    );
  });

  it("rejects an EVM address on a Solana chain", () => {
    expect(validateChainAddress(VALID_EVM_ADDRESS, SOLANA_CHAIN_ID)).toBe(
      false
    );
  });

  it("rejects garbage input on either chain family", () => {
    expect(validateChainAddress("not an address", EVM_CHAIN_ID)).toBe(false);
    expect(validateChainAddress("not an address", SOLANA_CHAIN_ID)).toBe(false);
  });
});

describe("validateChainTxHash", () => {
  it("accepts a valid EVM tx hash on an EVM chain", () => {
    expect(validateChainTxHash(VALID_EVM_TX_HASH, EVM_CHAIN_ID)).toBe(true);
  });

  it("rejects a Solana signature on an EVM chain", () => {
    expect(validateChainTxHash(VALID_SOLANA_SIGNATURE, EVM_CHAIN_ID)).toBe(
      false
    );
  });

  it("accepts a valid Solana signature on a Solana chain", () => {
    expect(validateChainTxHash(VALID_SOLANA_SIGNATURE, SOLANA_CHAIN_ID)).toBe(
      true
    );
  });

  it("rejects an EVM tx hash on a Solana chain", () => {
    expect(validateChainTxHash(VALID_EVM_TX_HASH, SOLANA_CHAIN_ID)).toBe(false);
  });

  it("rejects garbage input on either chain family", () => {
    expect(validateChainTxHash("not a hash", EVM_CHAIN_ID)).toBe(false);
    expect(validateChainTxHash("not a hash", SOLANA_CHAIN_ID)).toBe(false);
  });
});

describe("evmOnlyGuard", () => {
  it("returns null for an EVM chain", () => {
    expect(evmOnlyGuard(EVM_CHAIN_ID)).toBeNull();
  });

  it("returns a failure result for a Solana chain", () => {
    const result = evmOnlyGuard(SOLANA_CHAIN_ID);
    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Solana is not supported");
  });
});
