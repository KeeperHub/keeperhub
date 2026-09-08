import type { VersionedBlockResponse } from "@solana/web3.js";
import type { NormalizedBlock, NormalizedTx } from "../match/types";

const INVOKE_RE = /^Program (\w+) invoke \[/;

/**
 * Extracts the distinct set of program IDs invoked in a transaction from its
 * `Program <id> invoke [depth]` log lines (covers top-level and CPI calls).
 */
export function parseInvokedPrograms(logs: string[]): string[] {
  const programs = new Set<string>();
  for (const line of logs) {
    const match = INVOKE_RE.exec(line);
    if (match) {
      programs.add(match[1]);
    }
  }
  return [...programs];
}

/**
 * Flattens a web3.js `getBlock` result into the matcher's `NormalizedBlock`.
 * `transactions` is absent in `transactionDetails: "none"` mode (block-only
 * chains) - it degrades to an empty tx list, so event matching yields nothing
 * while block matching still runs off the header fields.
 */
export function normalizeBlock(
  slot: number,
  block: VersionedBlockResponse,
): NormalizedBlock {
  const transactions: NormalizedTx[] = [];
  for (const entry of block.transactions ?? []) {
    const logMessages = entry.meta?.logMessages ?? [];
    transactions.push({
      signature: entry.transaction.signatures[0] ?? "",
      programIds: parseInvokedPrograms(logMessages),
      logMessages,
      failed: entry.meta?.err != null,
    });
  }
  // web3.js's VersionedBlockResponse type omits blockHeight even though the RPC
  // returns it; read it defensively.
  const blockHeight =
    (block as unknown as { blockHeight?: number | null }).blockHeight ?? null;
  return {
    slot,
    blockHeight,
    blockhash: block.blockhash,
    blockTime: block.blockTime ?? null,
    parentSlot: block.parentSlot,
    transactions,
  };
}
