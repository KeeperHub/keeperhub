import type { NormalizedBlock } from "../match/types";

/**
 * `triggerData` for a Solana block trigger - the Solana analog of the EVM
 * block-dispatcher's `{ blockNumber, blockHash, blockTimestamp, parentHash }`.
 * Slot + blockHeight replace blockNumber; parentSlot replaces parentHash.
 */
export interface SolanaBlockPayload {
  chainType: "solana";
  slot: number;
  blockHeight: number | null;
  blockhash: string;
  blockTime: number | null;
  parentSlot: number;
}

export function buildBlockPayload(block: NormalizedBlock): SolanaBlockPayload {
  return {
    chainType: "solana",
    slot: block.slot,
    blockHeight: block.blockHeight,
    blockhash: block.blockhash,
    blockTime: block.blockTime,
    parentSlot: block.parentSlot,
  };
}
