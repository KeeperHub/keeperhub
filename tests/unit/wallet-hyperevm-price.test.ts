/**
 * HyperEVM (chainId 999) holdings are priced through DefiLlama. Without a
 * chain slug, `coinId` in lib/wallet/asset-prices.ts returns null, the asset
 * never reaches the price request, and the wallet reports its USDC and USDT0
 * as unpriced. A wrong slug is worse than none: DefiLlama answers an unknown
 * chain key with an empty object and no error, so the failure is silent.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DEFILLAMA_CHAIN_SLUGS } from "@/lib/scan/price/defillama";

const HYPEREVM = 999;

describe("HyperEVM asset pricing", () => {
  it("uses DefiLlama's canonical key for the chain", () => {
    // DefiLlama lists chain 999 as "Hyperliquid L1", keyed `hyperliquid`.
    // `hyperevm` also resolves there, but only as an alias.
    expect(DEFILLAMA_CHAIN_SLUGS[HYPEREVM]).toBe("hyperliquid");
  });
});
