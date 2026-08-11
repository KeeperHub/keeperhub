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

export type ResolvedRpcConfig = {
  chainId: number;
  chainName: string;
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  /**
   * True when the private-mempool swap put the chain's relay (Flashbots
   * Protect and friends, from `chains.default_private_rpc_url`) on the primary.
   * Every other endpoint we hand out is one we run: chain defaults come from
   * env-configured infrastructure. The fallback is never the relay -- strict
   * mode clears it, non-strict keeps the public endpoint the swap replaced.
   */
  primaryIsPrivateRelay?: boolean;
  primaryWssUrl?: string;
  fallbackWssUrl?: string;
  // KEEP-137: whether the chain supports private mempool routing (Flashbots Protect).
  // Set from chains.usePrivateMempoolRpc; UI uses this to gate the Private Mempool toggle.
  usePrivateMempoolRpc?: boolean;
  // The private mempool RPC URL (from chains.defaultPrivateRpcUrl) when supported.
  // Populated even when usePrivateMempool was NOT requested, so callers can surface
  // capabilities to the UI without a second lookup.
  privateRpcUrl?: string;
  source: "user" | "default";
};

export const SUPPORTED_CHAIN_IDS = {
  // EVM Mainnets
  MAINNET: 1,
  BASE: 8453,
  TEMPO_MAINNET: 4217,
  // EVM Testnets
  SEPOLIA: 11_155_111,
  BASE_SEPOLIA: 84_532,
  TEMPO_TESTNET: 42_431,
  // Solana
  SOLANA_MAINNET: 101,
  SOLANA_DEVNET: 103,
} as const;

export type SupportedChainId =
  (typeof SUPPORTED_CHAIN_IDS)[keyof typeof SUPPORTED_CHAIN_IDS];
