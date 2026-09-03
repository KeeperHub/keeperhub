/**
 * Nonce Manager for KeeperHub Web3 Operations
 *
 * Provides distributed nonce management using a row-based TTL lock to prevent
 * nonce collisions between concurrent workflow executions on the same
 * (wallet_address, chain_id).
 *
 * Lock primitive: the wallet_locks row IS the lock. A row with locked_by != NULL
 * AND expires_at > NOW() is held; everything else is takeable. Acquire is an
 * atomic conditional UPSERT (INSERT ON CONFLICT DO NOTHING, then UPDATE WHERE
 * expired). Release clears the holder. The expires_at TTL is the safety net:
 * a crashed holder cannot wedge the wallet+chain forever.
 *
 * KEEP-344: replaces the previous pg_advisory_lock + dedicated-connection model,
 * which leaked locks indefinitely if the holding connection survived a missed
 * release path.
 */

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { pendingTransactions, walletLocks } from "@/lib/db/schema-extensions";
import {
  ErrorCategory,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { sleep } from "@/lib/sleep";

export type NonceSession = {
  walletAddress: string;
  chainId: number;
  executionId: string;
  currentNonce: number;
  startedAt: Date;
  /**
   * Set once the lock can no longer be proved held: an extension found the row
   * taken by another execution, or the session outlived MAX_SESSION_TTLS and
   * the heartbeat gave up. From then on the nonces this session hands out are
   * not exclusive, and getNextNonce refuses to hand out any more.
   */
  lost?: boolean;
};

/**
 * Thrown by getNextNonce when the session can no longer prove it holds the
 * lock. Terminal for the session: the caller must not broadcast, and the
 * wallet+chain belongs to whoever holds the row now.
 */
export class NonceLockLostError extends Error {
  override readonly name = "NonceLockLostError" as const;

  constructor(
    session: Pick<NonceSession, "walletAddress" | "chainId" | "executionId">
  ) {
    super(
      `Nonce lock for ${session.walletAddress}:${session.chainId} is no longer held by ${session.executionId}; refusing to allocate a nonce.`
    );
  }
}

/**
 * What the heartbeat needs from a session. It exists from the moment the lock
 * is held (before the chain reads that size the session) and is grown into
 * the NonceSession the caller receives, so `lost` lands on the object they
 * hold.
 */
type LockLease = Pick<
  NonceSession,
  "walletAddress" | "chainId" | "executionId" | "lost"
>;

/**
 * The session's chain reads, plus which endpoint answered the last one.
 *
 * executeWithFailover switches endpoint on a throw or a timeout, so two reads
 * in the same session can be answered by different nodes holding different
 * mempools. The reconciler has to know when that happened: "not in the
 * mempool" is only evidence that a transaction dropped if the node that
 * answered is the same one whose nonce we are reconciling against.
 */
type SessionReader = {
  read: <T>(operation: (provider: ethers.Provider) => Promise<T>) => Promise<T>;
  /** The provider that served the most recent read. */
  lastEndpoint: () => ethers.Provider | null;
};

/**
 * Route the session's chain reads through the failover manager when one is
 * given, so they get the same per-attempt timeout and fallback as every other
 * RPC call. A bare provider is still accepted for callers that hold one.
 */
function chainReader(rpc: RpcProviderManager | ethers.Provider): SessionReader {
  if ("executeWithFailover" in rpc) {
    let lastEndpoint: ethers.Provider | null = null;
    return {
      read: (operation) =>
        rpc.executeWithFailover((provider) => {
          // The provider handed to the attempt that resolves is the one that
          // answered, so recording it on every attempt leaves the winner.
          lastEndpoint = provider;
          return operation(provider);
        }, "read"),
      lastEndpoint: () => lastEndpoint,
    };
  }
  return {
    read: (operation) => operation(rpc),
    lastEndpoint: () => rpc,
  };
}

// Extensions per TTL. At four, an extension lands every quarter of the TTL,
// so a lock survives two consecutive failed extensions with a quarter of the
// TTL still to run. The third failure is the knife edge, not the margin: the
// fourth beat falls due exactly when expires_at passes.
const HEARTBEATS_PER_TTL = 4;

// Beats stop after this many TTLs, so a session that never ends cannot renew
// the lock forever. At the default 300s TTL that caps the beating at 25
// minutes and the lock itself at 30 - the same bound the stale-execution
// reaper applies to workflow executions. The withdraw route has no reaper at
// all (its execution ids are not workflow_executions rows), so for that path
// this is the only upper bound there is.
const MAX_SESSION_TTLS = 5;

export type ValidationResult = {
  valid: boolean;
  chainNonce: number;
  pendingCount: number;
  reconciledCount: number;
  warnings: string[];
};

export type NonceManagerOptions = {
  lockTtlMs?: number;
  maxLockRetries?: number;
  lockRetryDelayMs?: number;
};

const DEFAULT_OPTIONS: Required<NonceManagerOptions> = {
  // One failover-wrapped RPC call is bounded at 3 attempts x 30s timeout plus
  // 1s + 2s backoff = 93s per endpoint, 186s for a primary-then-fallback
  // round (lib/rpc/providers DEFAULT_MAX_RETRIES / DEFAULT_TIMEOUT_MS), and a
  // write issues several such calls (fee reads, estimateGas, broadcast,
  // reconcile, receipt wait). With the primary down a single write can hold
  // the lock for well over this TTL, so the TTL is not sized to outlast a
  // write. The heartbeat extends expires_at every lockTtlMs / 4 while the
  // session is open, so the TTL bounds a holder that stopped beating: one
  // whose process died, or one that hit MAX_SESSION_TTLS. Those two together
  // bound how long any holder can wedge the wallet+chain at
  // (MAX_SESSION_TTLS + 1) x lockTtlMs.
  lockTtlMs: 300_000,
  // 600 * 200ms = 120s acquire budget: how long a waiter tolerates a live
  // holder before failing with the saturation error below. It covers a
  // healthy write (seconds) many times over but not a write riding out RPC
  // failover (several 186s rounds); a waiter then fails loudly rather than
  // sharing the holder's nonce. The TTL bounds *dead* holders; the retry
  // budget bounds the wait for *live* ones.
  maxLockRetries: 600,
  lockRetryDelayMs: 200,
};

export class NonceManager {
  private readonly lockTtlMs: number;
  private readonly maxLockRetries: number;
  private readonly lockRetryDelayMs: number;
  private readonly heartbeats = new Map<
    LockLease,
    ReturnType<typeof setInterval>
  >();

  constructor(options: NonceManagerOptions = {}) {
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_OPTIONS.lockTtlMs;
    this.maxLockRetries =
      options.maxLockRetries ?? DEFAULT_OPTIONS.maxLockRetries;
    this.lockRetryDelayMs =
      options.lockRetryDelayMs ?? DEFAULT_OPTIONS.lockRetryDelayMs;
  }

  /**
   * Start a nonce session for workflow execution.
   * 1. Acquires distributed lock (row-based, with TTL)
   * 2. Starts the heartbeat that keeps the lock alive while the session is open
   * 3. Fetches nonce from chain (source of truth)
   * 4. Validates and reconciles pending transactions
   */
  async startSession(
    walletAddress: string,
    chainId: number,
    executionId: string,
    rpc: RpcProviderManager | ethers.Provider
  ): Promise<{ session: NonceSession; validation: ValidationResult }> {
    const normalizedAddress = walletAddress.toLowerCase();
    const reader = chainReader(rpc);

    await this.acquireLock(normalizedAddress, chainId, executionId);

    const lease: LockLease = {
      walletAddress: normalizedAddress,
      chainId,
      executionId,
      lost: false,
    };
    this.startHeartbeat(lease);

    try {
      // Fetch nonce from chain (source of truth)
      const chainNonce = await reader.read((provider) =>
        provider.getTransactionCount(normalizedAddress, "pending")
      );
      // Every reconciliation verdict below is relative to this nonce, so it is
      // only sound on the node that produced it.
      const nonceEndpoint = reader.lastEndpoint();

      // Reconcile pending rows against chain state BEFORE computing safeNonce
      // so future-nonce phantom rows (broadcast failed / evicted from mempool)
      // don't poison the max-nonce read below and permanently widen the gap.
      const validation = await this.validateAndReconcile(
        normalizedAddress,
        chainId,
        chainNonce,
        reader,
        nonceEndpoint
      );

      // Advance past any in-flight nonces still pending after reconciliation
      const maxDbPending = await db
        .select({ maxNonce: sql<number>`max(${pendingTransactions.nonce})` })
        .from(pendingTransactions)
        .where(
          and(
            eq(pendingTransactions.walletAddress, normalizedAddress),
            eq(pendingTransactions.chainId, chainId),
            eq(pendingTransactions.status, "pending")
          )
        );
      const maxPendingNonce: number | null = maxDbPending[0]?.maxNonce ?? null;
      const safeNonce =
        maxPendingNonce === null
          ? chainNonce
          : Math.max(chainNonce, maxPendingNonce + 1);

      // Same object as the lease, so the heartbeat keeps writing to what the
      // caller holds.
      const session: NonceSession = Object.assign(lease, {
        currentNonce: safeNonce,
        startedAt: new Date(),
      });

      console.log(
        `[NonceManager] Session started for ${normalizedAddress}:${chainId}, ` +
          `nonce=${safeNonce}, chainNonce=${chainNonce}, execution=${executionId}`
      );

      if (validation.warnings.length > 0) {
        logWarn("[NonceManager] Validation warnings", {
          warnings: validation.warnings.join("; "),
        });
      }

      return { session, validation };
    } catch (error) {
      // Release lock on setup failure so the wallet isn't held by a session
      // that never actually started.
      this.stopHeartbeat(lease);
      await this.releaseLock(normalizedAddress, chainId, executionId);
      throw error;
    }
  }

  /**
   * Validate pending transactions and reconcile with chain state.
   * Called at workflow start before any transactions are executed.
   */
  private async validateAndReconcile(
    walletAddress: string,
    chainId: number,
    chainNonce: number,
    reader: SessionReader,
    nonceEndpoint: ethers.Provider | null
  ): Promise<ValidationResult> {
    const warnings: string[] = [];
    let reconciledCount = 0;

    const pending = await db
      .select()
      .from(pendingTransactions)
      .where(
        and(
          eq(pendingTransactions.walletAddress, walletAddress),
          eq(pendingTransactions.chainId, chainId),
          eq(pendingTransactions.status, "pending")
        )
      )
      .orderBy(pendingTransactions.nonce);

    for (const tx of pending) {
      if (tx.nonce < chainNonce) {
        const receipt = await reader.read((provider) =>
          provider.getTransactionReceipt(tx.txHash)
        );

        if (receipt) {
          await db
            .update(pendingTransactions)
            .set({ status: "confirmed", confirmedAt: new Date() })
            .where(
              and(
                eq(pendingTransactions.walletAddress, tx.walletAddress),
                eq(pendingTransactions.chainId, tx.chainId),
                eq(pendingTransactions.nonce, tx.nonce)
              )
            );
          reconciledCount += 1;
        } else {
          await db
            .update(pendingTransactions)
            .set({ status: "replaced" })
            .where(
              and(
                eq(pendingTransactions.walletAddress, tx.walletAddress),
                eq(pendingTransactions.chainId, tx.chainId),
                eq(pendingTransactions.nonce, tx.nonce)
              )
            );
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) was replaced or dropped`
          );
          reconciledCount += 1;
        }
      } else if (tx.nonce === chainNonce) {
        const mempoolTx = await reader.read((provider) =>
          provider.getTransaction(tx.txHash)
        );

        if (mempoolTx) {
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) still pending in mempool ` +
              `since ${tx.submittedAt?.toISOString()}`
          );
        } else if (reader.lastEndpoint() === nonceEndpoint) {
          await db
            .update(pendingTransactions)
            .set({ status: "dropped" })
            .where(
              and(
                eq(pendingTransactions.walletAddress, tx.walletAddress),
                eq(pendingTransactions.chainId, tx.chainId),
                eq(pendingTransactions.nonce, tx.nonce)
              )
            );
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) dropped from mempool`
          );
          reconciledCount += 1;
        } else {
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) not found, but a different ` +
              "RPC endpoint answered than the one that gave us the chain nonce; " +
              "left pending rather than treated as dropped"
          );
        }
      } else {
        // tx.nonce > chainNonce: row claims a future nonce. If the tx is no
        // longer in the mempool (broadcast failed / evicted), reap it so the
        // gap with chainNonce doesn't permanently wedge nonce selection.
        const mempoolTx = await reader.read((provider) =>
          provider.getTransaction(tx.txHash)
        );

        if (mempoolTx) {
          warnings.push(
            `Future-nonce tx ${tx.txHash} (nonce ${tx.nonce} > chain nonce ${chainNonce}) ` +
              "still in mempool, queued behind predecessors"
          );
        } else if (reader.lastEndpoint() === nonceEndpoint) {
          await db
            .update(pendingTransactions)
            .set({ status: "dropped" })
            .where(
              and(
                eq(pendingTransactions.walletAddress, tx.walletAddress),
                eq(pendingTransactions.chainId, tx.chainId),
                eq(pendingTransactions.nonce, tx.nonce)
              )
            );
          warnings.push(
            `Future-nonce tx ${tx.txHash} (nonce ${tx.nonce} > chain nonce ${chainNonce}) ` +
              "not in mempool, marked dropped"
          );
          reconciledCount += 1;
        } else {
          // A node that never saw the broadcast reports every transaction as
          // absent. Dropping the row on that answer removes nonce N from
          // maxDbPending and hands it straight back out, so the safe reading
          // of "a different endpoint answered" is no reading at all: leave the
          // row pending and let safeNonce step past it.
          warnings.push(
            `Future-nonce tx ${tx.txHash} (nonce ${tx.nonce} > chain nonce ${chainNonce}) ` +
              "not found, but a different RPC endpoint answered than the one that " +
              "gave us the chain nonce; left pending rather than treated as dropped"
          );
        }
      }
    }

    const remainingPending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingTransactions)
      .where(
        and(
          eq(pendingTransactions.walletAddress, walletAddress),
          eq(pendingTransactions.chainId, chainId),
          eq(pendingTransactions.status, "pending")
        )
      );

    return {
      valid: warnings.length === 0,
      chainNonce,
      pendingCount: remainingPending[0]?.count ?? 0,
      reconciledCount,
      warnings,
    };
  }

  /**
   * Get the next nonce and increment for subsequent transactions.
   * Call this for each transaction in a multi-tx workflow.
   *
   * A session that can no longer prove it holds the lock gets no more nonces.
   * This is a narrowing, not a fence: it closes the window from the moment the
   * loss is observed to the next allocation, which is the whole window for the
   * second and later transactions of a session. It does NOT cover a loss
   * observed after a nonce was already handed out and before that nonce is
   * broadcast - the gas reads and the broadcast in between can take minutes on
   * a degraded endpoint. Closing that window needs the pending_transactions row
   * to be reserved, fenced on locked_by, BEFORE the broadcast rather than
   * recorded after it, which is a change at every broadcast site.
   */
  getNextNonce(session: NonceSession): number {
    if (session.lost) {
      throw new NonceLockLostError(session);
    }
    const nonce = session.currentNonce;
    session.currentNonce += 1;
    return nonce;
  }

  /**
   * Record a submitted transaction.
   * Call after successfully sending a transaction.
   */
  async recordTransaction(
    session: NonceSession,
    nonce: number,
    txHash: string,
    workflowId?: string,
    gasPrice?: string
  ): Promise<void> {
    await db
      .insert(pendingTransactions)
      .values({
        walletAddress: session.walletAddress,
        chainId: session.chainId,
        nonce,
        txHash,
        executionId: session.executionId,
        workflowId,
        gasPrice,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: [
          pendingTransactions.walletAddress,
          pendingTransactions.chainId,
          pendingTransactions.nonce,
        ],
        set: {
          txHash,
          executionId: session.executionId,
          workflowId,
          gasPrice,
          status: "pending",
          submittedAt: new Date(),
          confirmedAt: sql`null`,
        },
      });

    console.log(
      `[NonceManager] Recorded tx: nonce=${nonce}, hash=${txHash}, ` +
        `execution=${session.executionId}`
    );
  }

  /**
   * Mark a transaction as confirmed.
   * Call after tx.wait() succeeds.
   */
  async confirmTransaction(txHash: string): Promise<void> {
    await db
      .update(pendingTransactions)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(pendingTransactions.txHash, txHash));
  }

  /**
   * End the session and release the lock.
   * Call when workflow execution completes (success or failure).
   */
  async endSession(session: NonceSession): Promise<void> {
    // Stop before releasing: a beat landing after the release would find no
    // row on its fence and report a lock loss that never happened.
    this.stopHeartbeat(session);
    await this.releaseLock(
      session.walletAddress,
      session.chainId,
      session.executionId
    );

    console.log(
      `[NonceManager] Session ended for ${session.walletAddress}:${session.chainId}, ` +
        `execution=${session.executionId}`
    );
  }

  /**
   * Extend expires_at every lockTtlMs / HEARTBEATS_PER_TTL while the lock is
   * held. Fenced on locked_by = executionId like releaseLock, so a beat can
   * never revive a lock another execution has taken over; finding no row to
   * extend is how the holder learns it lost the lock.
   */
  private startHeartbeat(lease: LockLease): void {
    const deadline = Date.now() + this.lockTtlMs * MAX_SESSION_TTLS;
    let beatInFlight = false;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        this.giveUpHeartbeat(lease);
        return;
      }
      // Never start a beat while one is still out. On a saturated pool the
      // beats would otherwise queue up as waiters on the pool that is already
      // the bottleneck.
      if (beatInFlight) {
        return;
      }
      beatInFlight = true;
      // Nobody to throw to from a timer: extendLock reports through the
      // logger and the lease's `lost` flag instead.
      this.extendLock(lease)
        .catch(() => undefined)
        .finally(() => {
          beatInFlight = false;
        });
    }, this.lockTtlMs / HEARTBEATS_PER_TTL);
    // A pending beat must never keep the process alive: a process on its way
    // out is exactly the holder the TTL exists to clear.
    timer.unref();
    this.heartbeats.set(lease, timer);
  }

  private stopHeartbeat(lease: LockLease): void {
    const timer = this.heartbeats.get(lease);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(lease);
    }
  }

  /**
   * Stop beating for a session that has outlived MAX_SESSION_TTLS. The lock is
   * still held for up to one more TTL - long enough for an in-flight broadcast
   * to be recorded - but the session gets no further nonces, because within
   * that TTL the row becomes takeable and we would have no way to know.
   */
  private giveUpHeartbeat(lease: LockLease): void {
    this.stopHeartbeat(lease);
    lease.lost = true;
    logSystemWarn(
      ErrorCategory.INFRASTRUCTURE,
      `[NonceManager] Session lifetime exceeded for ${lease.walletAddress}:${lease.chainId}`,
      new Error(
        `[NonceManager] Session lifetime exceeded for ${lease.walletAddress}:${lease.chainId}, ` +
          `holder=${lease.executionId}: heartbeat stopped after ${MAX_SESSION_TTLS} TTLs, ` +
          "the lock will lapse within one more"
      ),
      {
        wallet_address: lease.walletAddress,
        chain_id: String(lease.chainId),
        execution_id: lease.executionId,
      }
    );
  }

  private async extendLock(lease: LockLease): Promise<void> {
    const { walletAddress, chainId, executionId } = lease;
    let extended: { walletAddress: string }[];
    try {
      extended = await db
        .update(walletLocks)
        // NOW(), not a JS Date: the JS value would be fixed when the statement
        // is built, so a beat that waits 200s on a saturated pool would write
        // an expiry only lockTtlMs - 200s away. Postgres evaluates NOW() when
        // the statement actually lands.
        .set({
          expiresAt: sql`NOW() + ${this.lockTtlMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(walletLocks.walletAddress, walletAddress),
            eq(walletLocks.chainId, chainId),
            eq(walletLocks.lockedBy, executionId)
          )
        )
        .returning({ walletAddress: walletLocks.walletAddress });
    } catch (error) {
      // A beat that errors is not a lost lock: the fence may well still hold,
      // and the next beat retries with three quarters of the TTL in hand.
      logWarn("[NonceManager] Lock heartbeat failed", {
        wallet_address: walletAddress,
        chain_id: String(chainId),
        execution_id: executionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Extended, or the session ended while this beat was in flight and the
    // release cleared the row first: nothing to report either way.
    if (extended.length > 0 || !this.heartbeats.has(lease)) {
      return;
    }

    this.stopHeartbeat(lease);
    lease.lost = true;
    logSystemWarn(
      ErrorCategory.INFRASTRUCTURE,
      `[NonceManager] Lock lost for ${walletAddress}:${chainId}`,
      new Error(
        `[NonceManager] Lock lost for ${walletAddress}:${chainId}, ` +
          `holder=${executionId}: heartbeat found the lock held by another execution`
      ),
      {
        wallet_address: walletAddress,
        chain_id: String(chainId),
        execution_id: executionId,
      }
    );
  }

  /**
   * Acquire the wallet+chain lock. Each attempt runs two atomic statements:
   *   1. INSERT ... ON CONFLICT DO NOTHING — wins if no row exists for this
   *      wallet+chain yet.
   *   2. UPDATE ... WHERE locked_by IS NULL OR expires_at < NOW() — takes over
   *      an unheld or expired lock. Postgres serializes concurrent UPDATEs on
   *      the same row, so only one of N concurrent takers wins per round.
   * On real contention (lock held, not yet expired), sleep and retry.
   */
  private async acquireLock(
    walletAddress: string,
    chainId: number,
    executionId: string
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxLockRetries; attempt++) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockTtlMs);

      const inserted = await db
        .insert(walletLocks)
        .values({
          walletAddress,
          chainId,
          lockedBy: executionId,
          lockedAt: now,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ walletAddress: walletLocks.walletAddress });

      if (inserted.length > 0) {
        console.log(
          `[NonceManager] Lock acquired for ${walletAddress}:${chainId}, ` +
            `execution=${executionId}, expires=${expiresAt.toISOString()}`
        );
        return;
      }

      // Read the prior holder before the takeover so observability can
      // distinguish "took over from a wedged execution" from "took over a
      // never-held row." We only log this if the takeover actually wins.
      const priorHolderRow = await db
        .select({
          lockedBy: walletLocks.lockedBy,
          expiresAt: walletLocks.expiresAt,
        })
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, walletAddress),
            eq(walletLocks.chainId, chainId)
          )
        )
        .limit(1);

      const taken = await db
        .update(walletLocks)
        .set({
          lockedBy: executionId,
          lockedAt: now,
          expiresAt,
        })
        .where(
          and(
            eq(walletLocks.walletAddress, walletAddress),
            eq(walletLocks.chainId, chainId),
            or(
              isNull(walletLocks.lockedBy),
              lt(walletLocks.expiresAt, sql`NOW()`)
            )
          )
        )
        .returning({ walletAddress: walletLocks.walletAddress });

      if (taken.length > 0) {
        const priorHolder = priorHolderRow[0]?.lockedBy ?? null;
        const priorExpires = priorHolderRow[0]?.expiresAt;
        if (priorHolder !== null) {
          // Takeover from an expired holder is the operational smoke signal
          // for KEEP-344-class incidents — log it loudly so we can correlate
          // with whichever execution leaked the lock.
          const expiredAgoMs = priorExpires
            ? Date.now() - priorExpires.getTime()
            : null;
          logSystemWarn(
            ErrorCategory.INFRASTRUCTURE,
            `[NonceManager] Lock takeover for ${walletAddress}:${chainId}`,
            new Error(
              `[NonceManager] Lock takeover for ${walletAddress}:${chainId}, ` +
                `priorHolder=${priorHolder}, expiredAgoMs=${expiredAgoMs}, ` +
                `newHolder=${executionId}`
            ),
            {
              wallet_address: walletAddress,
              chain_id: String(chainId),
              prior_holder: priorHolder,
              expired_ago_ms:
                expiredAgoMs === null ? "unknown" : String(expiredAgoMs),
              execution_id: executionId,
            }
          );
        }
        console.log(
          `[NonceManager] Lock acquired for ${walletAddress}:${chainId}, ` +
            `execution=${executionId}, expires=${expiresAt.toISOString()}, ` +
            `attempt=${attempt + 1}`
        );
        return;
      }

      await sleep(this.lockRetryDelayMs);
    }

    // Exhausting the budget means the wallet is oversubscribed, not that the
    // engine faulted: writes from one wallet are serialized by design, and the
    // lock is the only thing that measures the overload. Reported as a user
    // error so it carries an actionable message and counts a metric without
    // paging, and phrased so the author knows which lever to pull.
    const waitSeconds = Math.round(
      (this.maxLockRetries * this.lockRetryDelayMs) / 1000
    );
    const failure = new Error(
      `Wallet is saturated: could not acquire the nonce lock for ${walletAddress}:${chainId} after ${waitSeconds}s. Transactions from one wallet are sent one at a time, so reduce this workflow's trigger rate or spread writes across additional wallets.`
    );
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[NonceManager] acquire_failed",
      failure,
      {
        wallet_address: walletAddress,
        chain_id: String(chainId),
        execution_id: executionId,
        max_retries: String(this.maxLockRetries),
      }
    );
    throw failure;
  }

  /**
   * Release the lock if (and only if) we still hold it. No-op if another
   * holder has already taken over an expired lock from us.
   */
  private async releaseLock(
    walletAddress: string,
    chainId: number,
    executionId: string
  ): Promise<void> {
    await db
      .update(walletLocks)
      .set({
        lockedBy: null,
        lockedAt: null,
        expiresAt: sql`NOW()`,
      })
      .where(
        and(
          eq(walletLocks.walletAddress, walletAddress),
          eq(walletLocks.chainId, chainId),
          eq(walletLocks.lockedBy, executionId)
        )
      );

    console.log(
      `[NonceManager] Lock released for ${walletAddress}:${chainId}, ` +
        `execution=${executionId}`
    );
  }
}

// Singleton instance
let instance: NonceManager | null = null;

export function getNonceManager(options?: NonceManagerOptions): NonceManager {
  if (!instance) {
    instance = new NonceManager(options);
  }
  return instance;
}

// Reset singleton (for testing)
export function resetNonceManager(): void {
  instance = null;
}
