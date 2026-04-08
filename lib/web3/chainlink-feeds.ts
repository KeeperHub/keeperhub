import "server-only";
import type { Address } from "viem";

/**
 * Chainlink ETH/USD price feed addresses per chain.
 * All feeds use 8 decimal places.
 */
const ETH_USD_FEEDS: Record<number, Address> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // Ethereum
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5", // Optimism
  137: "0xF9680D99D6C9589e2a93a78A04A279e509205945", // Polygon
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Base
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // Arbitrum
};

/**
 * Known testnet chain IDs where Pimlico doesn't charge for sponsorship.
 */
const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  11_155_111, // Sepolia
  84_532, // Base Sepolia
]);

export function getEthUsdFeedAddress(chainId: number): Address | undefined {
  return ETH_USD_FEEDS[chainId];
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
