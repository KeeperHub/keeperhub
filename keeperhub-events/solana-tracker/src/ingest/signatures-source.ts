import {
  type ConfirmedSignatureInfo,
  SolanaJSONRPCError,
} from "@solana/web3.js";
import {
  SOLANA_SIGNATURES_POLL_INTERVAL_MS,
  SOLANA_SIGNATURES_STALL_RESET_MS,
} from "../../lib/config/environment";
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
 *
 * Polling is floored at `pollIntervalMs`: the slot tick is only a wake-up, and
 * honouring every one would issue a query per program about as fast as RPC
 * latency allows. Ticks arriving inside the interval coalesce into a single
 * deferred poll, so a wake-up is delayed to the interval boundary, never lost.
 */
const MAX_SIGNATURES_PER_TICK = 1_000;
/** Bounds one poll's paging at 10k signatures per program. */
const MAX_SIGNATURE_PAGES = 10;
/**
 * The code the RPC returns for an `until`/`before` signature it cannot resolve,
 * alongside "Transaction <sig> not found". Verified identical on both gateway
 * routes and on api.testnet.solana.com, so it is the validator's behaviour
 * rather than one provider's. web3.js 1.98.4 exports SolanaJSONRPCErrorCode but
 * that table stops at -32016, so there is no constant to import.
 */
const RPC_TRANSACTION_NOT_FOUND = -32020;

/**
 * Whether the RPC rejected our cursor itself, as opposed to failing the query.
 * A malformed signature is a different code (-32602 "Invalid param: WrongSize"),
 * so this does not fire on one - and must not, because dropping a cursor skips
 * the window.
 */
function isUnknownCursorError(err: unknown): boolean {
  return (
    err instanceof SolanaJSONRPCError &&
    typeof err.code === "number" &&
    err.code === RPC_TRANSACTION_NOT_FOUND
  );
}

export class SignaturesSource implements BlockSource {
  private connection: SolanaConnection | null = null;
  private readonly cursors = new Map<string, string>();
  /**
   * When each program last completed a poll without throwing, which includes a
   * poll that found nothing - a quiet program is the normal case and must never
   * look stalled. Only programs holding a cursor are tracked, because a program
   * without one is already re-seeding on every poll.
   */
  private readonly lastSuccessAt = new Map<string, number>();
  private isProcessing = false;
  private pendingTick = false;
  private lastPollAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: BlockSourceOptions,
    private readonly pollIntervalMs: number = SOLANA_SIGNATURES_POLL_INTERVAL_MS,
    private readonly stallResetMs: number = SOLANA_SIGNATURES_STALL_RESET_MS,
  ) {}

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
          this.setCursor(programId, seed[0].signature);
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
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pendingTick = false;
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
    const sinceLastPoll = Date.now() - this.lastPollAt;
    if (sinceLastPoll < this.pollIntervalMs) {
      // Too soon. Defer to the interval boundary, coalescing every tick that
      // arrives before then into this one timer.
      if (this.pollTimer === null) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          this.onTick();
        }, this.pollIntervalMs - sinceLastPoll);
      }
      return;
    }
    this.runPoll();
  }

  private runPoll(): void {
    this.isProcessing = true;
    void this.poll()
      .catch((err) => {
        logger.warn(
          `[signatures] chain ${this.opts.chainId} poll error: ${formatError(err)}`,
        );
      })
      .finally(() => {
        // Stamped on completion, not on entry. Measuring from entry means any
        // poll slower than the interval leaves the guard already satisfied when
        // it finishes, so the source runs back-to-back on exactly the busy
        // chains the floor exists to protect.
        this.lastPollAt = Date.now();
        this.isProcessing = false;
        if (this.pendingTick) {
          this.pendingTick = false;
          this.onTick();
        }
      });
  }

  /**
   * One pass over every watched program.
   *
   * Each program is isolated: the query and its follow-up fetches are one
   * round trip per program, so letting a rejection escape the loop would skip
   * every program after it - one unreachable program would silently stop the
   * rest of the chain's workflows, not just its own.
   */
  private async poll(): Promise<void> {
    for (const programId of this.opts.watchedProgramIds) {
      if (!this.connection) {
        return;
      }
      try {
        await this.pollProgram(programId);
        // Success means the query returned, empty included. A program with
        // nothing new is the normal case and must not read as stalled.
        if (this.cursors.has(programId)) {
          this.lastSuccessAt.set(programId, Date.now());
        }
      } catch (err) {
        this.handleProgramError(programId, err);
      }
    }
  }

  private async pollProgram(programId: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    const until = this.cursors.get(programId);
    if (!until) {
      // Not seeded yet (seed failed at start, or a rejected cursor was
      // dropped); seed now, process nothing.
      const seed = await this.connection.getSignaturesForAddress(programId, {
        limit: 1,
      });
      if (seed[0]) {
        this.setCursor(programId, seed[0].signature);
      }
      return;
    }
    const sigs = await this.collectSignaturesSince(programId, until);
    if (sigs.length === 0) {
      return;
    }
    // Newest-first from the RPC; advance the cursor to the newest, process
    // oldest-first so downstream ordering matches on-chain ordering.
    const newest = sigs[0].signature;
    for (let i = sigs.length - 1; i >= 0; i--) {
      const info = sigs[i];
      if (info.err) {
        continue; // failed tx emits no meaningful events
      }
      if (!this.connection) {
        // stop() ran mid-window; drop the rest rather than dispatching for a
        // chain the reconciler has already torn down.
        return;
      }
      await this.processSignature(info.signature, info.slot);
    }
    this.setCursor(programId, newest);
  }

  /**
   * A failed poll either invalidates the cursor or does not. Getting this wrong
   * in either direction costs events: keeping a cursor the endpoint will never
   * resolve stalls the program forever, because the cursor only advances on
   * success and so the same rejected value is retried on every poll; dropping a
   * usable cursor re-seeds to head and skips the window.
   */
  private handleProgramError(programId: string, err: unknown): void {
    const cursor = this.cursors.get(programId);
    if (cursor && isUnknownCursorError(err)) {
      this.dropCursor(programId);
      logger.warn(
        `[signatures] chain ${this.opts.chainId} program ${programId} cursor ${cursor} is unknown to the endpoint; re-seeding to head and skipping that window. An endpoint serving a different cluster than the cursor came from does this (KEEP-1202).`,
      );
      return;
    }
    if (cursor && this.hasStalled(programId)) {
      this.dropCursor(programId);
      logger.error(
        `[signatures] chain ${this.opts.chainId} program ${programId} completed no poll for ${this.stallResetMs}ms; dropping cursor ${cursor} and re-seeding to head, skipping that window. Last error: ${formatError(err)}`,
      );
      return;
    }
    logger.warn(
      `[signatures] chain ${this.opts.chainId} program ${programId} poll error: ${formatError(err)}`,
    );
  }

  /**
   * True once a program holding a cursor has gone `stallResetMs` without a poll
   * that completed. The clock starts when the cursor is set, so a program that
   * has never succeeded still trips it rather than waiting forever for a first
   * success that may never come.
   */
  private hasStalled(programId: string): boolean {
    const since = this.lastSuccessAt.get(programId);
    return since !== undefined && Date.now() - since >= this.stallResetMs;
  }

  /**
   * Keeps the cursor and its stall clock in lockstep - they are only ever set
   * and cleared together, including across stop()/start(), so a cursor can
   * never end up without a clock and so unable to trip the backstop.
   */
  private setCursor(programId: string, signature: string): void {
    this.cursors.set(programId, signature);
    this.lastSuccessAt.set(programId, Date.now());
  }

  private dropCursor(programId: string): void {
    this.cursors.delete(programId);
    this.lastSuccessAt.delete(programId);
  }

  /**
   * Every signature for `programId` newer than `until`, newest-first.
   *
   * One request returns at most `MAX_SIGNATURES_PER_TICK`, so a busy window
   * needs paging: without it the caller would advance its cursor to the newest
   * signature while never seeing anything older than the page boundary, dropping
   * those events permanently and silently. Paging walks backwards with `before`
   * until the window is exhausted. `MAX_SIGNATURE_PAGES` bounds the work a
   * single poll can do; hitting it is loud, because past that point events are
   * being dropped for real.
   */
  private async collectSignaturesSince(
    programId: string,
    until: string,
  ): Promise<ConfirmedSignatureInfo[]> {
    const collected: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      if (!this.connection) {
        break;
      }
      const batch = await this.connection.getSignaturesForAddress(programId, {
        until,
        before,
        limit: MAX_SIGNATURES_PER_TICK,
      });
      collected.push(...batch);
      if (batch.length < MAX_SIGNATURES_PER_TICK) {
        return collected;
      }
      before = batch[batch.length - 1].signature;
    }

    logger.error(
      `[signatures] chain ${this.opts.chainId} program ${programId} exceeded ${MAX_SIGNATURE_PAGES} pages (${collected.length} signatures) in one window; older signatures are being dropped - raise SOLANA_SIGNATURES_POLL_INTERVAL_MS pressure or move this chain to Geyser`,
    );
    return collected;
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
