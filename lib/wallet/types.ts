/**
 * Shared types for wallet functionality
 *
 * This is the single source of truth for token and wallet types
 * used across the application (workflow config, wallet dialog, etc.)
 */

// ============================================================================
// Chain Types
// ============================================================================

export type ChainData = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  explorerUrl: string | null;
  explorerAddressPath: string | null;
  isTestnet: boolean;
  isEnabled: boolean;
};

export type ChainBalance = {
  chainId: number;
  name: string;
  symbol: string;
  balance: string;
  loading: boolean;
  isTestnet: boolean;
  explorerUrl: string | null;
  error?: string;
};

// ============================================================================
// Token Types
// ============================================================================

/**
 * Supported token from the system-wide supported_tokens table.
 * These are pre-configured tokens (primarily stablecoins) available on each chain.
 *
 * When fetching tokens for a specific chain, the API returns all mainnet tokens
 * as a "master list" with availability info for the requested chain:
 * - `available: true` - Token has an official contract on this chain
 * - `available: false` - Token exists on mainnet but not on this chain
 * - `tokenAddress` - The chain-specific contract address (only when available)
 */
export type SupportedToken = {
  id: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  /** Whether this token is available on the requested chain. Undefined means available. */
  available?: boolean;
  /** Explorer URL for the token contract */
  explorerUrl?: string | null;
};

/**
 * Custom token added by user in workflow configuration.
 * Contains address and validated symbol from blockchain.
 */
export type CustomToken = {
  address: string;
  symbol: string;
};

/**
 * Organization-tracked token (custom tokens added by org admins).
 * @deprecated Use SupportedToken for system tokens, CustomToken for workflow config
 */
export type TokenData = {
  id: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
};

/**
 * Token balance state for display in wallet dialog.
 */
export type TokenBalance = {
  tokenId: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  balance: string;
  loading: boolean;
  error?: string;
};

/**
 * Supported token balance with loading state (for wallet dialog).
 */
export type SupportedTokenBalance = {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  balance: string;
  loading: boolean;
  error?: string;
  /** Whether this token is available on the chain. Undefined means available. */
  available?: boolean;
  /** Explorer URL for the token contract */
  explorerUrl?: string | null;
};

// ============================================================================
// Wallet Types
// ============================================================================

export type WalletData = {
  hasWallet: boolean;
  walletAddress?: string;
  solanaAddress?: string | null;
  walletId?: string;
  email?: string;
  createdAt?: string;
  canExportKey?: boolean;
  isOwner?: boolean;
};

// ============================================================================
// Token Field Value (for workflow config)
// ============================================================================

/**
 * Value structure stored in workflow node config for token selection.
 * Stores a single token - either a supported token (by ID) or a custom token (by address + symbol).
 */
export type TokenFieldValue = {
  mode: "supported" | "custom";
  supportedTokenId?: string;
  customToken?: CustomToken;
};
