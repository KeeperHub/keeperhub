/**
 * Client-safe list of the networks the scanner fans out across.
 *
 * Kept in lockstep with the protocol registries in
 * `lib/scan/adapters/protocol-registry.ts` (AAVE_V3_POOLS / LIDO_TOKENS /
 * SPARK_POOLS / SKY_SAVINGS). That module imports `server-only`, so the UI
 * cannot read it directly — this constant is the client-visible mirror used
 * for pre-scan messaging ("we scan these N networks"). If a chain is added to
 * a registry, add it here too.
 *
 * Order is display order (largest ecosystems first), not chain id order.
 */
export const SCAN_NETWORK_IDS: readonly number[] = [
  1, // Ethereum
  42_161, // Arbitrum
  8453, // Base
  10, // Optimism
  137, // Polygon
  4217, // Tempo (stablecoin-only — see STABLECOIN_ONLY_SCAN_CHAIN_IDS)
] as const;
