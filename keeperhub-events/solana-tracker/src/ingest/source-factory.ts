import { logger } from "../../lib/utils/logger";
import type { BlockSource, BlockSourceOptions } from "./block-source";
import { GetBlockSource } from "./getblock-source";
import { GeyserSource } from "./geyser-source";
import { SignaturesSource } from "./signatures-source";

/**
 * Ingestion strategy per chain, all satisfying the same BlockSource contract:
 *   - "getblock"    : whole-block pull, batched but unfiltered. Serves BOTH event
 *                     and block triggers. Default; cheap on low-volume chains.
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
      logger.warn(
        `[source-factory] chain ${opts.chainId}: signatures mode cannot serve block triggers; falling back to getBlock`,
      );
      return new GetBlockSource(opts);
    }
    return new SignaturesSource(opts);
  }
  return new GetBlockSource(opts);
}
