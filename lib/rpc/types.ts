/**
 * RPC Configuration Types
 */

export type ChainConfig = {
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  primaryWssUrl?: string;
  fallbackWssUrl?: string;
  isTestnet: boolean;
};

export type ExplorerConfigType = {
  chainId: number;
  chainType: string;
  explorerUrl?: string;
  explorerApiType?: string;
  explorerApiUrl?: string;
  explorerTxPath?: string;
  explorerAddressPath?: string;
  explorerContractPath?: string;
};

export const SUPPORTED_CHAIN_IDS = {
  // EVM Mainnets
  MAINNET: 1,
  BASE: 8453,
  TEMPO_MAINNET: 4217,
  HYPEREVM_MAINNET: 999,
  // EVM Testnets
  SEPOLIA: 11_155_111,
  HOODI: 560_048,
  BASE_SEPOLIA: 84_532,
  TEMPO_TESTNET: 42_431,
  // Solana
  SOLANA_MAINNET: 101,
  SOLANA_DEVNET: 103,
} as const;

export type SupportedChainId =
  (typeof SUPPORTED_CHAIN_IDS)[keyof typeof SUPPORTED_CHAIN_IDS];
