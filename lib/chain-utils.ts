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
