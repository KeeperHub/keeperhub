import "server-only";
import type { Address } from "viem";
import { SPONSORSHIP_CHAINS } from "@/lib/web3/sponsorship-chains-meta";

/**
 * Chainlink native-gas-token/USD price feed addresses per chain. Gas is paid in
 * each chain's native token, so the feed must match that token: ETH on the L1
 * and the ETH L2s, POL on Polygon. Pricing Polygon gas with an ETH feed
 * overstates its USD cost by orders of magnitude. All feeds report 8 decimals.
 */
const GAS_TOKEN_USD_FEEDS: Record<number, Address> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // Ethereum ETH/USD
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5", // Optimism ETH/USD
  137: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", // Polygon POL/USD
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Base ETH/USD
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // Arbitrum ETH/USD
};

/**
 * Testnet chains are never charged for sponsorship. Derived from the shared
 * SPONSORSHIP_CHAINS list so this can never drift from the sponsorship surface
 * (previously a separate hand-maintained set silently treated Polygon Amoy and
 * Arbitrum Sepolia as mainnet).
 */
const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set(
  SPONSORSHIP_CHAINS.filter((c) => c.isTestnet).map((c) => c.chainId)
);

export function getGasTokenUsdFeedAddress(
  chainId: number
): Address | undefined {
  return GAS_TOKEN_USD_FEEDS[chainId];
}

export function isTestnetChain(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.has(chainId);
}

/**
 * Minimal ABI for Chainlink AggregatorV3Interface -- only `latestRoundData`.
 */
export const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;
