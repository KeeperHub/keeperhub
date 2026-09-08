/**
 * Tempo (chainId 4217) is a stablecoin-only scan chain: no Aave/Lido/Spark/Sky
 * protocol registered, but seeded stablecoins worth scanning for balances. This
 * requires three pieces to stay in lockstep — scannability, DefiLlama pricing,
 * and the client-visible network list. These tests guard that they do.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  STABLECOIN_ONLY_SCAN_CHAIN_IDS,
  scannableChainIds,
} from "@/lib/scan/adapters/protocol-registry";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";
import { DEFILLAMA_CHAIN_SLUGS } from "@/lib/scan/price/defillama";

const TEMPO = 4217;

describe("Tempo scan support", () => {
  it("is a registered stablecoin-only scan chain", () => {
    expect(STABLECOIN_ONLY_SCAN_CHAIN_IDS).toContain(TEMPO);
  });

  it("scannableChainIds includes Tempo when it is enabled", () => {
    expect(scannableChainIds([1, TEMPO])).toContain(TEMPO);
  });

  it("scannableChainIds excludes Tempo when it is not enabled", () => {
    expect(scannableChainIds([1, 42_161])).not.toContain(TEMPO);
  });

  it("has a DefiLlama chain slug so its stablecoins get priced", () => {
    expect(DEFILLAMA_CHAIN_SLUGS[TEMPO]).toBe("tempo");
  });

  it("is listed in the client-visible network strip", () => {
    expect(SCAN_NETWORK_IDS).toContain(TEMPO);
  });

  it("every stablecoin-only scan chain is both priced and listed", () => {
    // If a chain is scannable but unpriced, its stablecoins show usdValue null
    // and the engine's dust filter drops every suggestion — a silent dead end.
    for (const chainId of STABLECOIN_ONLY_SCAN_CHAIN_IDS) {
      expect(DEFILLAMA_CHAIN_SLUGS[chainId]).toBeDefined();
      expect(SCAN_NETWORK_IDS).toContain(chainId);
    }
  });
});
