/**
 * Nonce Manager for KeeperHub Web3 Operations
 *
 * Provides distributed nonce management using PostgreSQL advisory locks
 * to prevent nonce collisions between concurrent workflow executions.
 *
 * Key features:
 * - Chain as source of truth (fetches nonce from RPC at session start)
 * - PostgreSQL advisory locks for distributed coordination
 * - Dedicated connection per session (not from pool) ensures lock cleanup on crash
 * - Pending transaction tracking for validation and recovery
 *
 * IMPORTANT: Advisory locks are session-level (tied to connection). Using the
 * connection pool would cause stale locks when processes crash. Each NonceSession
 * now uses a dedicated connection that is closed when the session ends, ensuring
 * PostgreSQL automatically releases the advisory lock.
 *
 * @see docs/keeperhub/KEEP-1240/nonce.md for full specification
 */

import { and, eq, sql } from "drizzle-orm";
import type { ethers } from "ethers";
import postgres from "postgres";
import { db } from "@/lib/db";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { pendingTransactions, walletLocks } from "@/lib/db/schema-extensions";

export type NonceSession = {
  walletAddress: string;
  chainId: number;
  executionId: string;
  currentNonce: number;
  startedAt: Date;
  /** Internal: dedicated connection for this session's advisory lock */
  _lockConnection?: postgres.Sql;
};

export type ValidationResult = {
  valid: boolean;
  chainNonce: number;
  pendingCount: number;
  reconciledCount: number;
  warnings: string[];
};

export type NonceManagerOptions = {
  lockTimeoutMs?: number;
  maxLockRetries?: number;
  lockRetryDelayMs?: number;
};

const DEFAULT_OPTIONS: Required<NonceManagerOptions> = {
  lockTimeoutMs: 60_000,
  maxLockRetries: 50,
  lockRetryDelayMs: 100,
};

const getConnectionString = () => getDatabaseUrl();

export class NonceManager {
  private readonly lockTimeoutMs: number;
  private readonly maxLockRetries: number;
  private readonly lockRetryDelayMs: number;

  constructor(options: NonceManagerOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_OPTIONS.lockTimeoutMs;
    this.maxLockRetries =
      options.maxLockRetries ?? DEFAULT_OPTIONS.maxLockRetries;
    this.lockRetryDelayMs =
      options.lockRetryDelayMs ?? DEFAULT_OPTIONS.lockRetryDelayMs;
  }

  /**
   * Start a nonce session for workflow execution.
   * 1. Acquires distributed lock (with dedicated connection)
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

    // Step 1: Acquire lock with dedicated connection
    const lockConnection = await this.acquireLock(
      normalizedAddress,
      chainId,
      executionId
    );

    try {
      // Step 2: Fetch nonce from chain (source of truth)
      const chainNonce = await provider.getTransactionCount(
        normalizedAddress,
        "pending"
      );

      // Step 2.5: Check DB pending transactions and advance past any in-flight nonces
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

      // Step 3: Validate and reconcile pending transactions
      const validation = await this.validateAndReconcile(
        normalizedAddress,
        chainId,
        chainNonce,
        provider
      );

      // Create session with dedicated connection reference
      const session: NonceSession = {
        walletAddress: normalizedAddress,
        chainId,
        executionId,
        currentNonce: safeNonce,
        startedAt: new Date(),
        _lockConnection: lockConnection,
      };

      console.log(
        `[NonceManager] Session started for ${normalizedAddress}:${chainId}, ` +
          `nonce=${safeNonce}, chainNonce=${chainNonce}, execution=${executionId}`
      );

      if (validation.warnings.length > 0) {
        console.warn(
          "[NonceManager] Validation warnings:",
          validation.warnings
        );
      }

      return { session, validation };
    } catch (error) {
      // Release lock on failure - close dedicated connection
      await this.releaseLockConnection(
        lockConnection,
        normalizedAddress,
        chainId,
        executionId
      );
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

    // Get our pending transactions
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

    // Check each pending transaction against chain
    for (const tx of pending) {
      // If nonce is less than chain nonce, tx should be confirmed or dropped
      if (tx.nonce < chainNonce) {
        const receipt = await provider.getTransactionReceipt(tx.txHash);

        if (receipt) {
          // Confirmed - update status
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
          // Nonce used but our tx not confirmed - likely replaced or dropped
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
        // Our pending tx has the next nonce - check if still in mempool
        const mempoolTx = await provider.getTransaction(tx.txHash);

        if (mempoolTx) {
          // Still pending in mempool - this could block us
          warnings.push(
            `Transaction ${tx.txHash} (nonce ${tx.nonce}) still pending in mempool ` +
              `since ${tx.submittedAt?.toISOString()}`
          );
        } else {
          // Dropped from mempool - mark as dropped
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
        // Future nonce - shouldn't happen, but log it
        warnings.push(
          `Found pending tx with future nonce: ${tx.nonce} > chain nonce ${chainNonce}`
        );
      }
    }

    // Count remaining pending after reconciliation
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
   * Closes the dedicated connection, which automatically releases the advisory lock.
   */
  async endSession(session: NonceSession): Promise<void> {
    if (session._lockConnection) {
      await this.releaseLockConnection(
        session._lockConnection,
        session.walletAddress,
        session.chainId,
        session.executionId
      );
      session._lockConnection = undefined;
    }

    console.log(
      `[NonceManager] Session ended for ${session.walletAddress}:${session.chainId}, ` +
        `execution=${session.executionId}`
    );
  }

  /**
   * Acquire distributed lock using PostgreSQL advisory lock.
   *
   * IMPORTANT: Creates a dedicated connection (not from pool) for the advisory lock.
   * Advisory locks are session-level - tied to the database connection. Using the
   * connection pool would cause stale locks when processes crash, because the
   * connection returns to the pool still holding the lock.
   *
   * The dedicated connection is returned and must be closed via releaseLockConnection()
   * when the session ends. Closing the connection automatically releases the lock.
   */
  private async acquireLock(
    walletAddress: string,
    chainId: number,
    executionId: string
  ): Promise<postgres.Sql> {
    const lockId = this.generateLockId(walletAddress, chainId);

    // Create dedicated connection for this lock (max: 1, not pooled)
    const lockConnection = postgres(getConnectionString(), { max: 1 });

    for (let attempt = 0; attempt < this.maxLockRetries; attempt++) {
      // Try non-blocking advisory lock on dedicated connection
      const result =
        await lockConnection`SELECT pg_try_advisory_lock(${lockId}) as acquired`;

      const acquired = result[0]?.acquired as boolean | undefined;

      if (acquired) {
        // Update lock tracking table (use pooled db for metadata)
        await db
          .insert(walletLocks)
          .values({
            walletAddress,
            chainId,
            lockedBy: executionId,
            lockedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [walletLocks.walletAddress, walletLocks.chainId],
            set: {
              lockedBy: executionId,
              lockedAt: new Date(),
            },
          });

        console.log(
          `[NonceManager] Lock acquired for ${walletAddress}:${chainId}, ` +
            `execution=${executionId}`
        );
        return lockConnection;
      }

      // Check for stale lock in metadata table
      const existingLock = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, walletAddress),
            eq(walletLocks.chainId, chainId)
          )
        )
        .limit(1);

      if (existingLock[0]?.lockedAt) {
        const lockAge = Date.now() - existingLock[0].lockedAt.getTime();
        if (lockAge > this.lockTimeoutMs) {
          // Stale lock detected - the holder's connection likely died
          // With dedicated connections, this should auto-release, but clear metadata
          console.warn(
            `[NonceManager] Stale lock detected for ${walletAddress}:${chainId}, ` +
              `holder=${existingLock[0].lockedBy}, age=${lockAge}ms. ` +
              "Clearing stale metadata and retrying."
          );

          // Clear the stale metadata - the advisory lock should be gone
          // if the holding connection died
          await db
            .update(walletLocks)
            .set({ lockedBy: null, lockedAt: null })
            .where(
              and(
                eq(walletLocks.walletAddress, walletAddress),
                eq(walletLocks.chainId, chainId)
              )
            );
          continue;
        }
      }

      await this.sleep(this.lockRetryDelayMs);
    }

    // Failed to acquire - close the dedicated connection
    await lockConnection.end();

    throw new Error(
      `Failed to acquire nonce lock for ${walletAddress}:${chainId} ` +
        `after ${this.maxLockRetries} attempts`
    );
  }

  /**
   * Release the lock by closing the dedicated connection.
   * PostgreSQL automatically releases advisory locks when the connection closes.
   */
  private async releaseLockConnection(
    lockConnection: postgres.Sql,
    walletAddress: string,
    chainId: number,
    executionId: string
  ): Promise<void> {
    // Clear lock tracking metadata (only if we hold it)
    await db
      .update(walletLocks)
      .set({ lockedBy: null, lockedAt: null })
      .where(
        and(
          eq(walletLocks.walletAddress, walletAddress),
          eq(walletLocks.chainId, chainId),
          eq(walletLocks.lockedBy, executionId)
        )
      );

    // Close the dedicated connection - this releases the advisory lock
    await lockConnection.end();

    console.log(
      `[NonceManager] Lock released for ${walletAddress}:${chainId}, ` +
        `execution=${executionId}`
    );
  }

  /**
   * Generate advisory lock ID from wallet address and chain ID.
   * Uses XOR to combine address prefix and chain ID into a 32-bit signed integer.
   */
  private generateLockId(walletAddress: string, chainId: number): number {
    const addressPart = Number.parseInt(walletAddress.slice(2, 10), 16);
    return (addressPart ^ chainId) & 0x7f_ff_ff_ff;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
