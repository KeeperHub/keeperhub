import { describe, expect, it } from "vitest";
import {
  BASE_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_TESTNET_CHAIN_ID,
  USDC_BASE_ADDRESS,
  USDC_TEMPO_ADDRESS,
} from "@/lib/agentic-wallet/constants";

describe("agentic-wallet constants", () => {
  it("USDC_BASE_ADDRESS matches Phase 33 CONTEXT Resolution #2", () => {
    expect(USDC_BASE_ADDRESS).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("USDC_TEMPO_ADDRESS matches Phase 33 CONTEXT Resolution #2", () => {
    expect(USDC_TEMPO_ADDRESS).toBe(
      "0x20c000000000000000000000b9537d11c60e8b50"
    );
  });

  it("chain ids are documented", () => {
    expect(BASE_CHAIN_ID).toBe(8453);
    expect(TEMPO_MAINNET_CHAIN_ID).toBe(4217);
    expect(TEMPO_TESTNET_CHAIN_ID).toBe(4218);
  });
});
