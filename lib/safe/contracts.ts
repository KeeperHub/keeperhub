/**
 * Safe contract address registry.
 *
 * Safe v1.4.1 uses Nick's deterministic deployer so the canonical addresses
 * are identical across all EVM chains where Safe has deployed. Per-chain
 * overrides are supported via CHAIN_OVERRIDES for the rare cases where a
 * chain has a non-canonical deployment.
 *
 * Source: https://github.com/safe-global/safe-deployments/tree/main/src/assets
 */

export const SAFE_VERSION = "1.4.1" as const;

/**
 * Safe Allowance Module v0.1.0 -- canonical deployment at the same address
 * on every supported chain (Nick's deterministic deployer). Exposes
 * addDelegate, setAllowance, deleteAllowance, executeAllowanceTransfer, etc.
 * Natively renders under "Spending Limits" in the Safe UI.
 */
export const ALLOWANCE_MODULE_VERSION = "0.1.0" as const;

export type SafeContractAddresses = {
  safeL2Singleton: string;
  safeSingleton: string;
  proxyFactory: string;
  compatibilityFallbackHandler: string;
  multiSend: string;
  multiSendCallOnly: string;
  allowanceModule: string;
};

const CANONICAL_ADDRESSES: SafeContractAddresses = {
  safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safeSingleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  compatibilityFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  allowanceModule: "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134",
} as const;

/**
 * Per-chain overrides for chains that do not use the canonical deployment.
 * Populated empty for now; every chain in SUPPORTED_SAFE_CHAIN_IDS has the
 * canonical Safe v1.4.1 + Allowance Module deployments.
 */
const CHAIN_OVERRIDES: Record<number, Partial<SafeContractAddresses>> = {};

/**
 * Chains we support for Safe deployment.
 *
 * Covers every mainnet + testnet pair where (a) KeeperHub has RPC and
 * chain metadata seeded and (b) Safe's v1.4.1 contracts + Allowance
 * Module are deployed at the canonical addresses.
 *
 * Intentionally excluded:
 * - Tempo / Plasma: no canonical Safe deployment at this address
 * - Solana: non-EVM, Safe doesn't run there
 */
export const SUPPORTED_SAFE_CHAIN_IDS = [
  // mainnets
  1, // Ethereum
  10, // Optimism
  8453, // Base
  42_161, // Arbitrum One
  56, // BNB Smart Chain
  137, // Polygon
  43_114, // Avalanche C-Chain
  // testnets
  11_155_111, // Sepolia
  11_155_420, // Optimism Sepolia
  84_532, // Base Sepolia
  421_614, // Arbitrum Sepolia
  97, // BSC testnet
  80_002, // Polygon Amoy
  43_113, // Avalanche Fuji
] as const;

export type SupportedSafeChainId = (typeof SUPPORTED_SAFE_CHAIN_IDS)[number];

export function isSafeSupportedChain(
  chainId: number
): chainId is SupportedSafeChainId {
  return (SUPPORTED_SAFE_CHAIN_IDS as readonly number[]).includes(chainId);
}

export function getSafeContracts(chainId: number): SafeContractAddresses {
  const overrides = CHAIN_OVERRIDES[chainId] ?? {};
  return { ...CANONICAL_ADDRESSES, ...overrides };
}

/**
 * L2 singleton emits events on every tx (Safe's observability contract).
 * All chains we deploy to at launch are L2-style (even mainnet benefits from
 * the event emission for indexers), so this is what we use by default.
 */
export function getSafeSingletonForDeploy(chainId: number): string {
  return getSafeContracts(chainId).safeL2Singleton;
}

/**
 * Canonical Allowance Module address for the chain. Safe's Allowance Module
 * is deployed at the same address across every supported chain via
 * deterministic deployment.
 */
export function getAllowanceModuleAddress(chainId: number): string {
  return getSafeContracts(chainId).allowanceModule;
}
