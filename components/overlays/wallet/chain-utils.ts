import { hasIndependentTokenList } from "@/lib/web3/independent-token-list-chains";

// Single source of truth for Tempo's categorical no-native-row rule and for
// which chains can have their native balance mirrored by a supported-token
// row -- see lib/wallet/build-withdrawable-assets.ts.
export {
  hidesNativeRow,
  isTempoChain,
} from "@/lib/wallet/build-withdrawable-assets";

export const MAINNET_CHAIN_ID = 1;

// Re-exported so wallet components keep importing chain helpers from one
// place; the list itself lives in lib/web3 because the supported-tokens API
// route needs the same answer.
export { hasIndependentTokenList };

// Display order for the wallet UI. Mainnets land at indexes 0-9, testnets at
// 10-19, anything else falls back to 999 and sorts after the curated list.
// The natural side-effect of these ranges: mainnets always render before
// testnets in any list sorted by getChainOrderIndex.
const CHAIN_DISPLAY_ORDER: Record<number, number> = {
  // Mainnets (curated lead)
  1: 0, // Ethereum
  8453: 1, // Base
  4217: 2, // Tempo
  42_161: 3, // Arbitrum One
  10: 4, // Optimism
  137: 5, // Polygon
  56: 6, // BNB Chain
  43_114: 7, // Avalanche
  // Testnets (same order, +10)
  11_155_111: 10, // Sepolia
  84_532: 11, // Base Sepolia
  42_431: 12, // Tempo testnet
  421_614: 13, // Arbitrum Sepolia
  11_155_420: 14, // Optimism Sepolia
  80_002: 15, // Polygon Amoy
  97: 16, // BSC testnet
  43_113: 17, // Avalanche Fuji
} as const;

export function getChainOrderIndex(chainId: number): number {
  return CHAIN_DISPLAY_ORDER[chainId] ?? 999;
}

export function hasPositiveBalance(value: string): boolean {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Trim only the redundant "Mainnet" suffix from a chain name. Testnet
 * suffixes (Sepolia, Amoy, Fuji, Testnet) are kept verbatim so users can
 * tell two same-network Safes apart at a glance ("Safe · Ethereum" vs
 * "Safe · Ethereum Sepolia").
 */
const MAINNET_SUFFIX_REGEX = / Mainnet$/;

export function getDisplayChainName(name: string): string {
  return name.replace(MAINNET_SUFFIX_REGEX, "");
}
