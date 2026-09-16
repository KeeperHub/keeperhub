// Chains whose token lineup does not mirror Ethereum mainnet's stablecoin set
// (Plasma ships USDT0 with no Circle USDC and no Sky USDS; Tempo mainnet and
// testnet pay gas in stablecoins; Arc mainnet and testnet carry their own
// lineup). For these chains the wallet modal and
// /api/supported-tokens return the chain's own supported_tokens rows directly
// instead of overlaying them on the mainnet master list, which would print a
// "Not available" row for every mainnet asset that simply does not exist
// there. One set, read by both consumers: it used to be two copies kept in
// sync by hand, and a chain added to one but not the other rendered correctly
// in the API and wrongly in the modal.
export const INDEPENDENT_TOKEN_LIST_CHAIN_IDS: ReadonlySet<number> = new Set([
  42_431, 4217, 9745, 5042, 5_042_002,
]);

export function hasIndependentTokenList(chainId: number): boolean {
  return INDEPENDENT_TOKEN_LIST_CHAIN_IDS.has(chainId);
}

const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "10": "Optimism",
  "100": "Gnosis",
  "137": "Polygon",
  "8453": "Base",
  "42161": "Arbitrum",
  "11155111": "Ethereum Sepolia",
  "84532": "Base Sepolia",
  "42431": "Tempo Testnet",
  "4217": "Tempo",
  "101": "Solana",
  "103": "Solana Devnet",
};

const EXPLORER_URLS: Record<string, string> = {
  "1": "https://etherscan.io/address/",
  "10": "https://optimistic.etherscan.io/address/",
  "8453": "https://basescan.org/address/",
  "42161": "https://arbiscan.io/address/",
  "11155111": "https://sepolia.etherscan.io/address/",
};

export function getChainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function getExplorerUrl(
  chainId: string,
  address: string
): string | null {
  const baseUrl = EXPLORER_URLS[chainId];
  return baseUrl ? `${baseUrl}${address}` : null;
}
