/**
 * Arc (chainId 5042) uses USDC as its native gas token, so USDC is the only
 * asset a wallet holds there. Without a DefiLlama slug, `coinId` in
 * lib/wallet/asset-prices.ts returns null, the asset never reaches the price
 * request, its `usdValue` stays null, and the wallet reports a $0 total with
 * the holding pushed into the unpriced bucket.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DEFILLAMA_CHAIN_SLUGS } from "@/lib/scan/price/defillama";

const ARC = 5042;
const ARC_TESTNET = 5_042_002;

describe("Arc asset pricing", () => {
  it("has a DefiLlama chain slug so its USDC gets priced", () => {
    expect(DEFILLAMA_CHAIN_SLUGS[ARC]).toBe("arc");
  });

  it("leaves Arc Testnet unslugged - testnet assets are dropped before the price request", () => {
    expect(DEFILLAMA_CHAIN_SLUGS[ARC_TESTNET]).toBeUndefined();
  });
});
