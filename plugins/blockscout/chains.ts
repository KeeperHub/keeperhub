/**
 * Canonical hosted Blockscout instance per chain ID.
 *
 * Single source of truth shared by the plugin definition (the Chain selector's
 * allowed chains) and the step runtime (instance resolution). Adding a chain
 * here makes it available everywhere -- no other edits needed.
 *
 * Chains not listed here require a Blockscout connection with an explicit
 * instance URL (BLOCKSCOUT_API_URL).
 *
 * Kept free of "server-only" so the client-loaded plugin definition can import
 * it (the step runtime is server-only and imports it via blockscout-core).
 */
export const BLOCKSCOUT_INSTANCES: Record<number, string> = {
  1: "https://eth.blockscout.com",
  11_155_111: "https://eth-sepolia.blockscout.com",
  8453: "https://base.blockscout.com",
  84_532: "https://base-sepolia.blockscout.com",
  10: "https://explorer.optimism.io",
  42_161: "https://arbitrum.blockscout.com",
  100: "https://gnosis.blockscout.com",
  137: "https://polygon.blockscout.com",
  4663: "https://robinhoodchain.blockscout.com",
};

// Chain IDs (as strings) with a hosted instance, for chain-select allowlists.
export const SUPPORTED_BLOCKSCOUT_CHAIN_IDS = Object.keys(BLOCKSCOUT_INSTANCES);
