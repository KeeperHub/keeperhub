/**
 * Normalized block/tx shapes the matchers operate on. The ingestor flattens a
 * web3.js `getBlock` result (whose account keys live in different places for
 * legacy vs versioned messages) into these plain shapes, so the matchers stay
 * pure and unit-testable without wrestling web3.js union types.
 */

export interface NormalizedTx {
  signature: string;
  /**
   * Program IDs invoked in this tx (top-level and via CPI), parsed from the
   * `Program <id> invoke [depth]` log lines. Matching on invoked programs -
   * rather than on all referenced account keys - is both more precise for
   * contract events and avoids the legacy-vs-v0 account-key union in web3.js.
   */
  programIds: string[];
  logMessages: string[];
  /** True if the transaction failed on-chain (no meaningful events emitted). */
  failed: boolean;
}

export interface NormalizedBlock {
  slot: number;
  /** Monotonic over produced blocks; null on older RPCs that omit it. */
  blockHeight: number | null;
  blockhash: string;
  blockTime: number | null;
  parentSlot: number;
  transactions: NormalizedTx[];
}
