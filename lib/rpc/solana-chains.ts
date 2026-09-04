/**
 * Which chain ids are Solana, and nothing else.
 *
 * Split out of provider-factory (which re-exports isSolanaChain, so callers
 * and their test mocks keep their existing import path) because that module
 * reaches ethers, @solana/web3.js, safeFetch and the database client. The
 * Workflow DevKit compiles lib/workflow/executor into a workflow-function
 * bundle where Node modules are forbidden, and the executor's transaction-hash
 * guard needs this test. Keep this module dependency-free.
 */

// Solana chain IDs (non-EVM)
const SOLANA_CHAIN_IDS = new Set([101, 103]);

/**
 * Check if a chain ID is a Solana chain
 */
export function isSolanaChain(chainId: number): boolean {
  return SOLANA_CHAIN_IDS.has(chainId);
}
