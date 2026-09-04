import { abortableSleep } from "./shutdown";

/**
 * Per-chain token bucket used to pace event dispatch to SQS.
 *
 * Replaces the fixed 0-10s random jitter (`DEFAULT_JITTER_MS`) that every
 * event-triggered execution paid unconditionally (issue #2290). The jitter
 * spread downstream load when a block matched many subscriptions, but it cost
 * a mean 5s on every event, including a single match on an otherwise idle
 * chain.
 *
 * A token bucket keeps the load-spreading property while making the delay
 * scale with actual contention:
 * - a single match takes a token that is already available and forwards
 *   immediately (no fixed mean delay);
 * - a large simultaneous batch drains at the configured rate, so downstream
 *   sees the same smoothed arrival the jitter produced, without the arbitrary
 *   reordering (a bucket preserves arrival order; per-event random sleeps do
 *   not).
 *
 * Backpressure: `take()` never queues. When the bucket is empty the caller
 * waits (a bounded sleep) and retries, so a burst larger than the drain rate
 * is paced rather than dropped or buffered without bound. The wait loop is
 * deliberately a sleep-poll rather than a condition queue: dispatch is
 * fire-and-forget per log and the bucket is contended by at most the number of
 * matched logs in one drain pass, so a wait queue would add machinery without
 * changing the outcome.
 *
 * The bucket is created once per chain and shared by every listener on that
 * chain, which is what makes the pacing global per chain rather than
 * per-workflow (a single workflow spiking would otherwise pace only itself and
 * the downstream spike would remain).
 */
export class TokenBucketPacer {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private readonly signal?: AbortSignal;

  /**
   * @param drainRate - tokens (events) released per second when contended.
   * @param capacity - maximum burst the bucket holds. Defaults to the drain
   *   rate so a single event never waits (it takes one of the available
   *   tokens) while a burst is still smoothed to the configured rate.
   * @param signal - shutdown signal. Once aborted the bucket stops pacing
   *   and every `take()` returns immediately, parked callers included. See
   *   `release` below.
   */
  constructor(
    drainRate: number,
    capacity: number = drainRate,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(drainRate) || drainRate <= 0) {
      throw new Error(
        `TokenBucketPacer: drainRate must be > 0, got ${drainRate}`,
      );
    }
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(
        `TokenBucketPacer: capacity must be > 0, got ${capacity}`,
      );
    }
    this.tokens = capacity;
    this.maxTokens = capacity;
    this.refillPerMs = drainRate / 1000;
    this.lastRefill = Date.now();
    this.signal = signal;
  }

  /**
   * Refills the bucket from elapsed time, then waits (if necessary) until a
   * token is available and consumes it.
   *
   * A single event when the bucket is full returns without waiting. Under a
   * burst the wait is bounded by how long the drain rate needs to release the
   * next token, so total latency for the tail of a large batch is
   * `batchSize / drainRate` — the same smoothed arrival the old jitter gave a
   * large batch, minus the unconditional mean.
   */
  async take(): Promise<void> {
    // Release: once shutdown has begun the bucket stops pacing entirely.
    // Waiting out the drain rate is not an option there - the drain that
    // follows has a fixed budget (SHUTDOWN_DRAIN_TIMEOUT_MS) and covers only
    // `budget * drainRate` events, so a burst larger than that would have its
    // tail killed at exit with no row, no queue entry and no replay. Bursting
    // the backlog into SQS instead makes the drain cost the dispatch, not the
    // pacing, and SQS absorbs the burst.
    if (this.signal?.aborted) {
      return;
    }

    // Refill from wall-clock so contention state survives between calls and
    // is shared correctly across listeners on the same chain.
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.maxTokens,
        this.tokens + elapsed * this.refillPerMs,
      );
      this.lastRefill = now;
    }

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Bucket empty: wait for the next token, then recurse (the recursive call
    // refills from the new wall-clock and consumes). Bounded by the drain
    // rate, never unbounded.
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await abortableSleep(Math.min(waitMs, 1000), this.signal);
    await this.take();
  }
}
