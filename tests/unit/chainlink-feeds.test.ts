import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getGasTokenUsdFeedAddress,
  isTestnetChain,
} from "@/lib/web3/chainlink-feeds";
import { SPONSORSHIP_CHAINS } from "@/lib/web3/sponsorship-chains-meta";

describe("getGasTokenUsdFeedAddress", () => {
  it("prices Polygon gas with the POL feed, not an ETH feed", () => {
    const polygon = getGasTokenUsdFeedAddress(137);
    const ethereum = getGasTokenUsdFeedAddress(1);
    expect(polygon).toBe("0xAB594600376Ec9fD91F8e885dADF0CE036862dE0");
    expect(polygon).not.toBe(ethereum);
  });

  it("returns the ETH/USD feed for ETH-gas chains", () => {
    expect(getGasTokenUsdFeedAddress(1)).toBe(
      "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
    );
    expect(getGasTokenUsdFeedAddress(8453)).toBe(
      "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"
    );
    expect(getGasTokenUsdFeedAddress(42_161)).toBe(
      "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"
    );
  });

  it("returns undefined for an unknown chain", () => {
    expect(getGasTokenUsdFeedAddress(999)).toBeUndefined();
  });
});

describe("isTestnetChain", () => {
  it("recognizes every sponsorship testnet (incl. Amoy and Arbitrum Sepolia)", () => {
    for (const chainId of [11_155_111, 80_002, 84_532, 421_614]) {
      expect(isTestnetChain(chainId)).toBe(true);
    }
  });

  it("treats sponsorship mainnets as non-testnet", () => {
    for (const chainId of [1, 137, 8453, 42_161]) {
      expect(isTestnetChain(chainId)).toBe(false);
    }
  });
});

describe("every billable sponsorship chain has a price feed", () => {
  // A mainnet on the sponsorship surface with no feed is billed at the
  // hardcoded fallback price. The primary guard is the type annotation on
  // GAS_TOKEN_USD_FEEDS, which makes that a compile error; this is the
  // runtime backstop for anyone who widens the annotation.
  const billable = SPONSORSHIP_CHAINS.filter((chain) => !chain.isTestnet);

  it.each(billable)("$name ($chainId) resolves a gas-token USD feed", ({
    chainId,
  }) => {
    expect(getGasTokenUsdFeedAddress(chainId)).toBeDefined();
  });
});
