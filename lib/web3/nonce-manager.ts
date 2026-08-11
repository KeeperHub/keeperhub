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

export type NonceSession = {
  walletAddress: string;
  chainId: number;
  executionId: string;
  currentNonce: number;
  startedAt: Date;
};

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
  // Worst-case credentialed write is ~90s (full RPC failover round). 5min
  // gives generous headroom; a wedged lock auto-clears at expires_at.
  lockTtlMs: 300_000,
  // 600 * 200ms = 120s acquire budget. Must outwait one full RPC failover
  // round (~90s per provider including timeouts and exponential backoff),
  // since preflight failover runs while a legitimate holder still has the
  // lock. The TTL bounds *stuck* holders; the retry budget bounds the wait
  // for *legitimate* holders to finish.
  maxLockRetries: 600,
  lockRetryDelayMs: 200,
};

export class NonceManager {
  private readonly lockTtlMs: number;
  private readonly maxLockRetries: number;
  private readonly lockRetryDelayMs: number;

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
   * 2. Fetches nonce from chain (source of truth)
   * 3. Validates and reconciles pending transactions
   */
  async startSession(
    walletAddress: string,
    chainId: number,
    executionId: string,
    provider: ethers.Provider
  ): Promise<{ session: NonceSession; validation: ValidationResult }> {
    const normalizedAddress = walletAddress.toLowerCase();

    await this.acquireLock(normalizedAddress, chainId, executionId);

    try {
      // Fetch nonce from chain (source of truth)
      const chainNonce = await provider.getTransactionCount(
        normalizedAddress,
        "pending"
      );

      // Reconcile pending rows against chain state BEFORE computing safeNonce
      // so future-nonce phantom rows (broadcast failed / evicted from mempool)
      // don't poison the max-nonce read below and permanently widen the gap.
      const validation = await this.validateAndReconcile(
        normalizedAddress,
        chainId,
        chainNonce,
        provider
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

      const session: NonceSession = {
        walletAddress: normalizedAddress,
        chainId,
        executionId,
        currentNonce: safeNonce,
        startedAt: new Date(),
      };

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
    provider: ethers.Provider
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
        const receipt = await provider.getTransactionReceipt(tx.txHash);

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
        const mempoolTx = await provider.getTransaction(tx.txHash);

        if (mempoolTx) {
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) still pending in mempool ` +
              `since ${tx.submittedAt?.toISOString()}`
          );
        } else {
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
        }
      } else {
        // tx.nonce > chainNonce: row claims a future nonce. If the tx is no
        // longer in the mempool (broadcast failed / evicted), reap it so the
        // gap with chainNonce doesn't permanently wedge nonce selection.
        const mempoolTx = await provider.getTransaction(tx.txHash);

        if (mempoolTx) {
          warnings.push(
            `Future-nonce tx ${tx.txHash} (nonce ${tx.nonce} > chain nonce ${chainNonce}) ` +
              "still in mempool, queued behind predecessors"
          );
        } else {
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
   */
  getNextNonce(session: NonceSession): number {
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

      await this.sleep(this.lockRetryDelayMs);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
