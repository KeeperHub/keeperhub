import { logger } from "../../lib/utils/logger";
import { formatError } from "../format-error";
import {
  type BlockSource,
  type BlockSourceOptions,
  disconnectedHealth,
} from "./block-source";
import { normalizeBlock } from "./normalize";
import { type ConnectionHealth, SolanaConnection } from "./solana-connection";

/**
 * The `getBlock`-polling BlockSource (the default). Drives off a `slotSubscribe`
 * tick, processes up to the CONFIRMED tip (not the processed edge, which leads
 * confirmation), enumerates produced slots with `getBlocks`, fetches each with
 * `getBlock`, normalizes, and hands the block to `onBlock`. Backfill is capped so
 * a lagging source catches up to head instead of chasing an unbounded gap.
 *
 * Detail level: `full` when event triggers are watched (needs logs), `none` for
 * block-only chains (cheap - header only).
 */
const MAX_BACKFILL_SLOTS = 100;

export class GetBlockSource implements BlockSource {
  private connection: SolanaConnection | null = null;
  private lastProcessedSlot: number | null = null;
  private isProcessing = false;
  private pendingTick = false;

  constructor(private readonly opts: BlockSourceOptions) {}

  async start(): Promise<void> {
    this.connection = new SolanaConnection({
      chainId: this.opts.chainId,
      endpoints: this.opts.endpoints,
      commitment: this.opts.commitment,
      // The slot tick is only a wake-up; the confirmed tip is the real target.
      onSlot: () => this.onSlot(),
    });
    this.connection.start();
    try {
      this.lastProcessedSlot = await this.connection.getCurrentSlot();
    } catch (err) {
      logger.warn(
        `[getblock] chain ${this.opts.chainId} cursor seed failed, will seed on first tick: ${formatError(err)}`,
      );
    }
    logger.log(
      `[getblock] chain ${this.opts.chainId} source started (detail=${this.detail()})`,
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

  private detail(): "full" | "none" {
    return this.opts.watchedProgramIds.length > 0 ? "full" : "none";
  }

  private onSlot(): void {
    if (this.isProcessing) {
      this.pendingTick = true;
      return;
    }
    this.isProcessing = true;
    void this.processConfirmed()
      .catch((err) => {
        logger.warn(
          `[getblock] chain ${this.opts.chainId} process error: ${formatError(err)}`,
        );
      })
      .finally(() => {
        this.isProcessing = false;
        if (this.pendingTick) {
          this.pendingTick = false;
          this.onSlot();
        }
      });
  }

  private async processConfirmed(): Promise<void> {
    if (!this.connection) {
      return;
    }
    let tip: number;
    try {
      tip = await this.connection.getCurrentSlot();
    } catch (err) {
      logger.warn(
        `[getblock] chain ${this.opts.chainId} getSlot failed: ${formatError(err)}`,
      );
      return;
    }
    if (this.lastProcessedSlot === null) {
      this.lastProcessedSlot = tip;
      return;
    }
    let from = this.lastProcessedSlot + 1;
    if (tip < from) {
      return;
    }
    if (tip - from > MAX_BACKFILL_SLOTS) {
      logger.warn(
        `[getblock] chain ${this.opts.chainId} behind by ${tip - from} slots (> ${MAX_BACKFILL_SLOTS}); processing the most recent ${MAX_BACKFILL_SLOTS}, older skipped`,
      );
      from = tip - MAX_BACKFILL_SLOTS;
    }

    const produced = await this.connection.getProducedSlots(from, tip);
    for (const slot of produced) {
      await this.processSlot(slot);
      // Advance per slot so a failure mid-range resumes at the failed slot
      // rather than re-processing (and re-firing block triggers for) the slots
      // that already succeeded in this range.
      this.lastProcessedSlot = slot;
    }
    this.lastProcessedSlot = tip;
  }

  private async processSlot(slot: number): Promise<void> {
    if (!this.connection) {
      return;
    }
    const raw = await this.connection.getBlock(slot, this.detail());
    if (!raw) {
      return; // skipped slot
    }
    await this.opts.onBlock(normalizeBlock(slot, raw));
  }
}
