import { describe, expect, it } from "vitest";
import { hasIndependentTokenList as fromWallet } from "@/components/overlays/wallet/chain-utils";
import {
  hasIndependentTokenList,
  INDEPENDENT_TOKEN_LIST_CHAIN_IDS,
} from "@/lib/web3/independent-token-list-chains";

describe("independent token list chains", () => {
  it("is one list, shared by the wallet overlay and the supported-tokens route", () => {
    // This list used to exist twice, hand-synced, and adding a chain to one
    // copy and not the other fails silently: the API answers with the
    // chain's own rows while the overlay renders the mainnet master list
    // against them. The wallet's helper is now the same function, so the
    // two cannot disagree.
    expect(fromWallet).toBe(hasIndependentTokenList);
  });

  it("covers the chains whose stablecoins do not mirror Ethereum's", () => {
    for (const chainId of [
      999, // HyperEVM: USDC and USDT0, no USDS
      9745, // Plasma: USDT0, no Circle USDC
      4217,
      42_431, // Tempo pays gas in stablecoins
      5042,
      5_042_002, // Arc: USDC is the native gas token
    ]) {
      expect(hasIndependentTokenList(chainId), `chain ${chainId}`).toBe(true);
    }
  });

  it("leaves chains that do mirror it on the master list", () => {
    for (const chainId of [1, 8453, 42_161, 11_155_111]) {
      expect(hasIndependentTokenList(chainId), `chain ${chainId}`).toBe(false);
    }
    expect(INDEPENDENT_TOKEN_LIST_CHAIN_IDS).not.toContain(1);
  });
});
