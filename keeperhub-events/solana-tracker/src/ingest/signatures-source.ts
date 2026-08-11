import { logger } from "../../lib/utils/logger";
import { formatError } from "../format-error";
import type { NormalizedBlock } from "../match/types";
import {
  type BlockSource,
  type BlockSourceOptions,
  disconnectedHealth,
} from "./block-source";
import { parseInvokedPrograms } from "./normalize";
import { type ConnectionHealth, SolanaConnection } from "./solana-connection";

/**
 * The `getSignaturesForAddress` BlockSource - the direct Solana analog of EVM's
 * `eth_getLogs`: a slot tick (like `newHeads`) drives a server-side
 * program-filtered signature query per watched program, then `getTransaction`
 * pulls each new tx's logs. Cheap (KB, filtered), unlike `getBlock`'s whole-block
 * pull - but not batched (one call per program), so it fits low/medium program
 * counts. EVENT triggers only: it produces one-transaction "blocks" (blockHeight
 * null) so the same matcher/enqueue path runs unchanged; block-height triggers
 * are served by the getBlock or Geyser sources.
 */
const MAX_SIGNATURES_PER_TICK = 1_000;

export class SignaturesSource implements BlockSource {
  private connection: SolanaConnection | null = null;
  private readonly cursors = new Map<string, string>();
  private isProcessing = false;
  private pendingTick = false;

  constructor(private readonly opts: BlockSourceOptions) {}

  async start(): Promise<void> {
    this.connection = new SolanaConnection({
      chainId: this.opts.chainId,
      endpoints: this.opts.endpoints,
      commitment: this.opts.commitment,
      onSlot: () => this.onTick(),
    });
    this.connection.start();
    // Seed each program's cursor to its latest signature so a cold start does
    // not replay history (mirrors the getBlock source's head-seed).
    for (const programId of this.opts.watchedProgramIds) {
      try {
        const seed = await this.connection.getSignaturesForAddress(programId, {
          limit: 1,
        });
        if (seed[0]) {
          this.cursors.set(programId, seed[0].signature);
        }
      } catch (err) {
        logger.warn(
          `[signatures] chain ${this.opts.chainId} seed for ${programId} failed: ${formatError(err)}`,
        );
      }
    }
    logger.log(
      `[signatures] chain ${this.opts.chainId} source started (programs=${this.opts.watchedProgramIds.length})`,
    );
  }

  async stop(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = null;
    }
  }

  getHealth(): ConnectionHealth {
    return (
      this.connection?.getHealth() ??
      disconnectedHealth(this.opts.chainId, this.opts.endpoints, "not started")
    );
  }

  private onTick(): void {
    if (this.isProcessing) {
      this.pendingTick = true;
      return;
    }
    this.isProcessing = true;
    void this.poll()
      .catch((err) => {
        logger.warn(
          `[signatures] chain ${this.opts.chainId} poll error: ${formatError(err)}`,
        );
      })
      .finally(() => {
        this.isProcessing = false;
        if (this.pendingTick) {
          this.pendingTick = false;
          this.onTick();
        }
      });
  }

  private async poll(): Promise<void> {
    if (!this.connection) {
      return;
    }
    for (const programId of this.opts.watchedProgramIds) {
      const until = this.cursors.get(programId);
      if (!until) {
        // Not seeded yet (seed failed at start); seed now, process nothing.
        const seed = await this.connection.getSignaturesForAddress(programId, {
          limit: 1,
        });
        if (seed[0]) {
          this.cursors.set(programId, seed[0].signature);
        }
        continue;
      }
      const sigs = await this.connection.getSignaturesForAddress(programId, {
        until,
        limit: MAX_SIGNATURES_PER_TICK,
      });
      if (sigs.length === 0) {
        continue;
      }
      if (sigs.length === MAX_SIGNATURES_PER_TICK) {
        logger.warn(
          `[signatures] chain ${this.opts.chainId} program ${programId} hit the ${MAX_SIGNATURES_PER_TICK} cap; older signatures in this window may be skipped`,
        );
      }
      // Newest-first from the RPC; advance the cursor to the newest, process
      // oldest-first so downstream ordering matches on-chain ordering.
      const newest = sigs[0].signature;
      for (let i = sigs.length - 1; i >= 0; i--) {
        const info = sigs[i];
        if (info.err) {
          continue; // failed tx emits no meaningful events
        }
        await this.processSignature(info.signature, info.slot);
      }
      this.cursors.set(programId, newest);
    }
  }

  private async processSignature(
    signature: string,
    slot: number,
  ): Promise<void> {
    if (!this.connection) {
      return;
    }
    const tx = await this.connection.getTransaction(signature);
    const logMessages = tx?.meta?.logMessages ?? [];
    // One-transaction "block": the matcher only uses per-tx fields + the slot
    // for event payloads, so the absent block header is fine; blockHeight null
    // means matchBlocks (block triggers) is a no-op for this source.
    const block: NormalizedBlock = {
      slot,
      blockHeight: null,
      blockhash: "",
      blockTime: tx?.blockTime ?? null,
      parentSlot: 0,
      transactions: [
        {
          signature,
          programIds: parseInvokedPrograms(logMessages),
          logMessages,
          failed: tx?.meta?.err != null,
        },
      ],
    };
    await this.opts.onBlock(block);
  }
}
