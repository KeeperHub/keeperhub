import type { BlockSource, BlockSourceOptions } from "./block-source";
import { CompositeSource } from "./composite-source";
import { GetBlockSource } from "./getblock-source";
import { GeyserSource } from "./geyser-source";
import { SignaturesSource } from "./signatures-source";

/**
 * Ingestion strategy per chain, all satisfying the same BlockSource contract:
 *   - "getblock"    : whole-block pull, batched but unfiltered. Serves BOTH event
 *                     and block triggers. Cheap on low-volume chains only.
 *   - "signatures"  : getSignaturesForAddress per program - server-side filtered
 *                     (the EVM eth_getLogs analog), event triggers only.
 *   - Geyser        : filtered + batched + pushed gRPC stream (mainnet scale).
 */
export type SourceMode = "getblock" | "signatures";

export interface GeyserConfig {
  endpoint: string;
  token?: string;
}

export interface SourceSelection {
  geyser?: GeyserConfig;
  sourceMode?: SourceMode;
  hasBlockTriggers?: boolean;
}

/**
 * Chains calls so each block is fully processed before the next begins,
 * regardless of which source produced it.
 *
 * The rejection still reaches the caller - `GetBlockSource` relies on a thrown
 * `onBlock` to hold its cursor at the failed slot - while the internal chain
 * absorbs it, so one failed block does not stall every block queued behind it.
 */
function serializeBlocks(
  onBlock: BlockSourceOptions["onBlock"],
): BlockSourceOptions["onBlock"] {
  let tail: Promise<unknown> = Promise.resolve();
  return (block) => {
    const processed = tail.then(() => onBlock(block));
    tail = processed.catch(() => undefined);
    return processed;
  };
}

export function createBlockSource(
  opts: BlockSourceOptions,
  selection: SourceSelection = {},
): BlockSource {
  if (selection.geyser) {
    return new GeyserSource({
      ...opts,
      geyserEndpoint: selection.geyser.endpoint,
      geyserToken: selection.geyser.token,
    });
  }
  if (selection.sourceMode === "signatures") {
    if (selection.hasBlockTriggers) {
      // The signatures source emits one-tx blocks with no header, so it cannot
      // serve block triggers. Pair it with a header-only getBlock (no watched
      // programs -> transactionDetails "none") rather than reverting the whole
      // chain to getBlock: that revert would put event matching back on the
      // full-block firehose, which is unaffordable at mainnet throughput.
      // Both members feed the same onBlock, and BlockSourceOptions specifies
      // that blocks are delivered serially - the ingestor's dedup is a
      // check-then-set spanning two awaits, so concurrent delivery could let one
      // signature past the check twice. Independent sources cannot honour that
      // between themselves, so serialize here rather than relying on the
      // members never producing the same transaction.
      const onBlock = serializeBlocks(opts.onBlock);
      return new CompositeSource(opts.chainId, opts.endpoints, [
        new SignaturesSource({ ...opts, onBlock }),
        new GetBlockSource({ ...opts, watchedProgramIds: [], onBlock }),
      ]);
    }
    return new SignaturesSource(opts);
  }
  return new GetBlockSource(opts);
}
