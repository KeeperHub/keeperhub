/**
 * Network utility functions for mapping network names to chain IDs
 */

import { SUPPORTED_CHAIN_IDS } from "./types";

/**
 * Map network name to chain ID
 *
 * Supports:
 * - Numeric chain IDs (passed through)
 * - Numeric strings (e.g., "1", "8453")
 * - Legacy network names (e.g., "mainnet", "sepolia", "base")
 */
export function getChainIdFromNetwork(network: string | number): number {
  // Runtime guard: untyped step configs can pass a missing value despite the
  // signature, which would otherwise die on .toLowerCase() with a TypeError.
  if (network === undefined || network === null || network === "") {
    throw new Error("Network is required");
  }

  // If already a number, return as-is
  if (typeof network === "number") {
    return network;
  }

  // Try parsing as a numeric string first (e.g., "1", "8453", "11155111")
  const parsed = Number.parseInt(network, 10);
  if (!Number.isNaN(parsed) && parsed > 0) {
    return parsed;
  }

  // Map legacy string names to chain IDs for backward compatibility
  const networkMap: Record<string, number> = {
    // Ethereum Mainnet
    mainnet: SUPPORTED_CHAIN_IDS.MAINNET,
    "eth-mainnet": SUPPORTED_CHAIN_IDS.MAINNET,
    "ethereum-mainnet": SUPPORTED_CHAIN_IDS.MAINNET,
    ethereum: SUPPORTED_CHAIN_IDS.MAINNET,
    // Ethereum Sepolia
    sepolia: SUPPORTED_CHAIN_IDS.SEPOLIA,
    "eth-sepolia": SUPPORTED_CHAIN_IDS.SEPOLIA,
    "sepolia-testnet": SUPPORTED_CHAIN_IDS.SEPOLIA,
    // Base Mainnet
    base: SUPPORTED_CHAIN_IDS.BASE,
    "base-mainnet": SUPPORTED_CHAIN_IDS.BASE,
    // Base Sepolia
    "base-sepolia": SUPPORTED_CHAIN_IDS.BASE_SEPOLIA,
    "base-testnet": SUPPORTED_CHAIN_IDS.BASE_SEPOLIA,
    // Tempo
    "tempo-testnet": SUPPORTED_CHAIN_IDS.TEMPO_TESTNET,
    tempo: SUPPORTED_CHAIN_IDS.TEMPO_MAINNET,
    "tempo-mainnet": SUPPORTED_CHAIN_IDS.TEMPO_MAINNET,
    // Solana
    solana: SUPPORTED_CHAIN_IDS.SOLANA_MAINNET,
    "solana-mainnet": SUPPORTED_CHAIN_IDS.SOLANA_MAINNET,
    "solana-devnet": SUPPORTED_CHAIN_IDS.SOLANA_DEVNET,
    "solana-testnet": SUPPORTED_CHAIN_IDS.SOLANA_DEVNET,
  };

  const chainId = networkMap[network.toLowerCase()];

  if (!chainId) {
    throw new Error(
      `Unsupported network: ${network}. Supported: ${Object.keys(networkMap).join(", ")} or numeric chain IDs`
    );
  }

  return chainId;
}

/**
 * Get network name from chain ID (for display purposes)
 */
export function getNetworkName(chainId: number): string {
  const chainNames: Record<number, string> = {
    [SUPPORTED_CHAIN_IDS.MAINNET]: "Ethereum Mainnet",
    [SUPPORTED_CHAIN_IDS.SEPOLIA]: "Ethereum Sepolia",
    [SUPPORTED_CHAIN_IDS.BASE]: "Base",
    [SUPPORTED_CHAIN_IDS.BASE_SEPOLIA]: "Base Sepolia",
    [SUPPORTED_CHAIN_IDS.TEMPO_TESTNET]: "Tempo Testnet",
    [SUPPORTED_CHAIN_IDS.TEMPO_MAINNET]: "Tempo",
    [SUPPORTED_CHAIN_IDS.SOLANA_MAINNET]: "Solana",
    [SUPPORTED_CHAIN_IDS.SOLANA_DEVNET]: "Solana Devnet",
  };

  return chainNames[chainId] || `Chain ${chainId}`;
}
