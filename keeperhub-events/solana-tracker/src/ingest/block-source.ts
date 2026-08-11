import type { Commitment } from "@solana/web3.js";
import type { NormalizedBlock } from "../match/types";
import type { ConnectionHealth, Endpoint } from "./solana-connection";

export type { ConnectionHealth, Endpoint } from "./solana-connection";

/**
 * A BlockSource produces `NormalizedBlock`s for one chain, in slot order. It is
 * the ingestion seam: `getBlock`-polling and Geyser/gRPC are two implementations
 * of the same contract, so everything downstream (matchers, decode, dedup, SQS)
 * is source-agnostic. `getBlock` fetches whole blocks and we filter client-side;
 * a Geyser source filters server-side (account_include) and pushes only the
 * watched programs' transactions - but both hand the ingestor the same block
 * shape (metadata + relevant txs).
 */
export interface BlockSourceOptions {
  chainId: number;
  endpoints: Endpoint[];
  commitment: Commitment;
  /**
   * Event-trigger program IDs. `getBlock` uses their presence to pick the block
   * detail level (full when events are watched, none for block-only chains); a
   * Geyser source uses them for server-side `account_include` filtering. Empty
   * means block triggers only.
   */
  watchedProgramIds: string[];
  /**
   * Invoked once per produced block, in order, and awaited so blocks are
   * processed serially (the ingestor runs the matchers + enqueue inside it).
   */
  onBlock: (block: NormalizedBlock) => Promise<void>;
}

export interface BlockSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): ConnectionHealth;
}

/** Health shown before a source has connected / after it stops. */
export function disconnectedHealth(
  chainId: number,
  endpoints: Endpoint[],
  reason: string,
): ConnectionHealth {
  return {
    chainId,
    connected: false,
    reconnecting: false,
    lastSlotAt: null,
    activeEndpoint: endpoints[0]?.wssUrl ?? "",
    lastError: reason,
  };
}
