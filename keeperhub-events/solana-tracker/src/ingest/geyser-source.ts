import { logger } from "../../lib/utils/logger";
import {
  type BlockSource,
  type BlockSourceOptions,
  disconnectedHealth,
} from "./block-source";
import type { ConnectionHealth } from "./solana-connection";

/**
 * Geyser / Yellowstone gRPC source (server-side filtered) - the mainnet answer.
 *
 * SEAM ONLY (not yet functional). It implements the same `BlockSource` contract
 * as `GetBlockSource`, but instead of polling 5 MB blocks it opens a gRPC
 * `blocks` subscription whose `accountInclude` is set to the watched programs,
 * so the provider assembles each block already filtered to the relevant
 * transactions (plus block metadata) and pushes it. Each block message maps to a
 * `NormalizedBlock` and is handed to `onBlock` - the matchers, Anchor decode,
 * dedup, and SQS enqueue downstream are unchanged. This is Solana's equivalent
 * of EVM `eth_getLogs`: KB/s of matches instead of ~1 TB/day of firehose.
 *
 * To make it functional (a follow-up, gated on a provider):
 *   - add `@triton-one/yellowstone-grpc` to package.json
 *   - const client = new Client(geyserEndpoint, geyserToken, undefined)
 *   - const stream = await client.subscribe()
 *   - stream.write({ blocks: { all: { accountInclude: watchedProgramIds,
 *       includeTransactions: true, includeAccounts: false } },
 *       commitment: CommitmentLevel.CONFIRMED })
 *   - for await (const msg of stream) if (msg.block)
 *       await onBlock(mapGeyserBlockToNormalized(msg.block))
 * The mapping mirrors `normalizeBlock`: slot/blockHeight/blockhash/parentSlot
 * from the block header, and per-tx signature + logMessages + invoked programs
 * from `msg.block.transactions`.
 */
export interface GeyserSourceOptions extends BlockSourceOptions {
  geyserEndpoint: string;
  geyserToken?: string;
}

export class GeyserSource implements BlockSource {
  constructor(private readonly opts: GeyserSourceOptions) {}

  start(): Promise<void> {
    logger.error(
      `[geyser] chain ${this.opts.chainId} GeyserSource is a seam only - not yet wired (needs @triton-one/yellowstone-grpc + endpoint ${this.opts.geyserEndpoint})`,
    );
    return Promise.reject(new Error("GeyserSource not yet implemented"));
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  getHealth(): ConnectionHealth {
    return disconnectedHealth(
      this.opts.chainId,
      this.opts.endpoints,
      "geyser not implemented",
    );
  }
}
