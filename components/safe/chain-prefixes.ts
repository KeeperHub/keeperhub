/**
 * Safe Transaction Service chain prefixes (EIP-3770 slugs).
 *
 * app.safe.global deep-links use `<prefix>:<address>`, e.g.
 *   https://app.safe.global/home?safe=base:0xABC...
 *
 * Unknown chain IDs return null; the caller should hide the "View on Safe"
 * link for those rather than linking to a broken URL.
 *
 * Every entry must be a chain Safe's client gateway still serves, and must use
 * the shortName that gateway reports. Safe's frontend resolves an unrecognised
 * prefix by falling through to Ethereum rather than erroring, so a stale entry
 * does not produce a dead link - it silently opens the wrong chain, which is
 * worse than the hidden link this map is designed to fall back to.
 *
 * Checked against safe-client.safe.global/v1/chains (53 chains, paginated in
 * full) on 2026-08-28. Optimism Sepolia (11155420), Arbitrum Sepolia (421614),
 * BSC Testnet (97), Polygon Amoy (80002) and Avalanche Fuji (43113) were
 * removed: Safe no longer lists any of them, so their links had been opening
 * Ethereum. All five remain in SUPPORTED_SAFE_CHAIN_IDS, so Safes can still be
 * deployed there; only the deep link is hidden.
 */
const SAFE_CHAIN_PREFIXES: Record<number, string> = {
  // mainnets
  1: "eth",
  10: "oeth",
  8453: "base",
  42161: "arb1",
  56: "bnb",
  137: "matic",
  43114: "avax",
  // testnets
  11155111: "sep",
  84532: "basesep",
};

export function getSafeChainPrefix(chainId: number): string | null {
  return SAFE_CHAIN_PREFIXES[chainId] ?? null;
}

export function getSafeAppUrl(
  chainId: number,
  safeAddress: string
): string | null {
  const prefix = getSafeChainPrefix(chainId);
  if (!prefix) {
    return null;
  }
  return `https://app.safe.global/home?safe=${prefix}:${safeAddress}`;
}

/**
 * Client-side explorer URL map. Mirrors the Etherscan V2 family used by
 * scripts/seed/seed-chains.ts so we don't need to fetch explorerConfigs
 * on the client. Unknown chains return null and the UI hides the link.
 */
const EXPLORER_BASE_URLS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  56: "https://bscscan.com",
  137: "https://polygonscan.com",
  43114: "https://snowtrace.io",
  11155111: "https://sepolia.etherscan.io",
  11155420: "https://sepolia-optimism.etherscan.io",
  84532: "https://sepolia.basescan.org",
  421614: "https://sepolia.arbiscan.io",
  97: "https://testnet.bscscan.com",
  80002: "https://amoy.polygonscan.com",
  43113: "https://testnet.snowtrace.io",
};

export function getExplorerAddressUrl(
  chainId: number,
  address: string
): string | null {
  const base = EXPLORER_BASE_URLS[chainId];
  if (!base) {
    return null;
  }
  return `${base}/address/${address}`;
}

export function getExplorerTxUrl(
  chainId: number,
  txHash: string
): string | null {
  const base = EXPLORER_BASE_URLS[chainId];
  if (!base) {
    return null;
  }
  return `${base}/tx/${txHash}`;
}

/**
 * Human-readable chain name for UI labels. Lives next to the explorer +
 * Safe-prefix maps so the same set of supported chains is referenced from
 * one place. Unknown chains fall back to "chain <id>" so the UI never
 * shows just a number.
 */
const CHAIN_DISPLAY_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  8453: "Base",
  42161: "Arbitrum One",
  56: "BNB Smart Chain",
  137: "Polygon",
  43114: "Avalanche",
  11155111: "Sepolia",
  11155420: "Optimism Sepolia",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
  97: "BNB Testnet",
  80002: "Polygon Amoy",
  43113: "Avalanche Fuji",
};

export function getChainDisplayName(chainId: number): string {
  return CHAIN_DISPLAY_NAMES[chainId] ?? `chain ${chainId}`;
}
