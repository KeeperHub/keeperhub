/**
 * Ethereum L1 chains KeeperHub supports: mainnet, Sepolia, Hoodi. One table for
 * the EIP-7825 gas cap and the Block Trigger slot clock; the scheduler keeps
 * their genesis times (a test checks the two agree).
 */
export const ETHEREUM_L1_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 11_155_111, 560_048,
]);
