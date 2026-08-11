import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  NATIVE_TOKEN_SENTINEL,
  tokenAddressForWire,
} from "@/lib/safe/roles-orchestrator";

/**
 * Regression coverage for the sentinel <-> null wire translation introduced
 * with the safe_role_direct_rules.token_address NOT NULL change (review
 * #923-r3 HIGH). DB stores NATIVE_TOKEN_SENTINEL for native rules so the
 * unique index can dedupe them under Postgres' default NULLs-are-distinct
 * semantics. The wire format predates that change and still returns
 * `null` for native rules. tokenAddressForWire is the single translation
 * point at the GET boundary.
 */
describe("tokenAddressForWire", () => {
  it("returns null when stored value is the native sentinel", () => {
    expect(tokenAddressForWire(NATIVE_TOKEN_SENTINEL)).toBeNull();
  });

  it("treats sentinel as case-insensitive (lowercased storage)", () => {
    expect(
      tokenAddressForWire("0x0000000000000000000000000000000000000000")
    ).toBeNull();
    expect(
      tokenAddressForWire("0X0000000000000000000000000000000000000000")
    ).toBeNull();
  });

  it("passes a real ERC-20 address through unchanged", () => {
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    expect(tokenAddressForWire(usdc)).toBe(usdc);
  });

  it("passes the lowercased storage form of a real address through", () => {
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    expect(tokenAddressForWire(usdc)).toBe(usdc);
  });
});
