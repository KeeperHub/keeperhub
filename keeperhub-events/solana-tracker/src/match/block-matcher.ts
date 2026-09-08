import {
  type SolanaBlockPayload,
  buildBlockPayload,
} from "../payload/block-payload";
import type { SolanaBlockTrigger } from "../registrations";
import type { NormalizedBlock } from "./types";

export interface BlockFire {
  workflowId: string;
  userId: string;
  payload: SolanaBlockPayload;
}

/**
 * Fires block triggers whose interval divides this block's height, mirroring
 * the EVM `blockNumber % blockInterval === 0` semantics. Uses block height
 * (not slot) so skipped/empty slots don't distort the cadence. Blocks without a
 * height (older RPCs) fire nothing.
 */
export function matchBlocks(
  block: NormalizedBlock,
  triggers: SolanaBlockTrigger[],
): BlockFire[] {
  if (block.blockHeight === null || block.blockHeight <= 0) {
    return [];
  }
  const height = block.blockHeight;
  const payload = buildBlockPayload(block);
  const fires: BlockFire[] = [];
  for (const trigger of triggers) {
    if (height % trigger.blockInterval === 0) {
      fires.push({
        workflowId: trigger.workflowId,
        userId: trigger.userId,
        payload,
      });
    }
  }
  return fires;
}
