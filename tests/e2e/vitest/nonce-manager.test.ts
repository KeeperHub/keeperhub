/**
 * E2E Tests for Nonce Manager
 *
 * Verifies the row-based TTL lock against a real PostgreSQL.
 *
 * Prerequisites:
 * - Database running with nonce manager tables
 * - Run: pnpm db:migrate
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Unmock db to use real database for e2e tests
vi.unmock("@/lib/db");
// A late landing loads server-only modules.
vi.mock("server-only", () => ({}));

import { pendingTransactions, walletLocks } from "@/lib/db/schema-extensions";
import {
  BUNDLE_PRE_RECORD_MS,
  LONGEST_BUNDLE_HOLD_MS,
} from "@/lib/web3/bundles/bundle-history";
import {
  NonceLockLostError,
  NonceManager,
  resetNonceManager,
} from "@/lib/web3/nonce-manager";

// Skip if DATABASE_URL not set or SKIP_INFRA_TESTS is true
const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

// Test wallet address (checksummed format, will be normalized to lowercase)
const TEST_WALLET = "0x1234567890AbCdEf1234567890AbCdEf12345678";
const TEST_WALLET_NORMALIZED = TEST_WALLET.toLowerCase();
const TEST_CHAIN_ID = 11_155_111; // Sepolia

// Regex patterns for assertions (at top level for performance)
const FAILED_LOCK_REGEX =
  /Wallet is saturated: could not acquire the nonce lock/;

// Mock provider that returns controlled nonce values
function createMockProvider(transactionCount: number) {
  return {
    getTransactionCount: async () => transactionCount,
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
  };
}

describe.skipIf(shouldSkip)("Nonce Manager E2E", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testExecutionId: string;

  beforeAll(async () => {
    // Connect to test database
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5433/KEEP-1240";

    client = postgres(connectionString, { max: 5 });
    db = drizzle(client);

    // Verify tables exist
    try {
      await db.select().from(walletLocks).limit(1);
      await db.select().from(pendingTransactions).limit(1);
    } catch (_error) {
      throw new Error(
        "Nonce manager tables not found. Run migrations first: pnpm db:push"
      );
    }
  });

  afterAll(async () => {
    // Cleanup all test data
    await db
      .delete(pendingTransactions)
      .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
    await client.end();
  });

  beforeEach(async () => {
    // Reset singleton and clean test data before each test
    resetNonceManager();
    testExecutionId = `test_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Clean up any leftover test data
    await db
      .delete(pendingTransactions)
      .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
  });

  describe("Lock Management", () => {
    it("should acquire and release lock for wallet/chain combination", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(5);

      // Start session (acquires lock)
      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      // Verify lock exists in database
      const locks = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locks.length).toBe(1);
      expect(locks[0].lockedBy).toBe(testExecutionId);
      expect(locks[0].lockedAt).toBeInstanceOf(Date);

      // End session (releases lock)
      await manager.endSession(session);

      // Verify lock is released (lockedBy should be null)
      const locksAfter = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locksAfter.length).toBe(1);
      expect(locksAfter[0].lockedBy).toBeNull();
    });

    it("should normalize wallet address to lowercase", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(10);

      const { session } = await manager.startSession(
        "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", // Mixed case
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      expect(session.walletAddress).toBe(
        "0xabcdef1234567890abcdef1234567890abcdef12"
      );

      // Verify in database
      const locks = await db
        .select()
        .from(walletLocks)
        .where(
          eq(
            walletLocks.walletAddress,
            "0xabcdef1234567890abcdef1234567890abcdef12"
          )
        );

      expect(locks.length).toBe(1);

      await manager.endSession(session);

      // Cleanup
      await db
        .delete(walletLocks)
        .where(
          eq(
            walletLocks.walletAddress,
            "0xabcdef1234567890abcdef1234567890abcdef12"
          )
        );
    });

    it("should track lock ownership in database", async () => {
      // NOTE: PostgreSQL advisory locks are connection-scoped. When using a shared
      // db connection (like @/lib/db singleton), multiple NonceManager instances
      // in the same process can acquire the same advisory lock because the connection
      // already holds it. The lock tracking table ensures we can audit lock ownership.
      //
      // For true distributed locking across different processes/workers, the advisory
      // lock mechanism works correctly since each process has its own db connection.

      const manager = new NonceManager();
      const provider = createMockProvider(5);

      // Start a session
      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_1`,
        provider as any
      );

      // Verify lock is recorded in database
      const locks = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locks).toHaveLength(1);
      expect(locks[0]?.lockedBy).toBe(`${testExecutionId}_1`);
      expect(locks[0]?.lockedAt).toBeTruthy();

      // End session - lock should be cleared
      await manager.endSession(session);

      // Verify lock is released in database
      const locksAfter = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locksAfter).toHaveLength(1);
      expect(locksAfter[0]?.lockedBy).toBeNull();
    }, 15_000);

    it("should allow concurrent sessions for different chains", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(5);

      // Session for chain 1
      const { session: session1 } = await manager.startSession(
        TEST_WALLET,
        1, // Mainnet
        `${testExecutionId}_chain1`,
        provider as any
      );

      // Session for chain 137 should succeed
      const manager2 = new NonceManager();
      const { session: session2 } = await manager2.startSession(
        TEST_WALLET,
        137, // Polygon
        `${testExecutionId}_chain137`,
        provider as any
      );

      expect(session1.chainId).toBe(1);
      expect(session2.chainId).toBe(137);

      // Cleanup
      await manager.endSession(session1);
      await manager2.endSession(session2);

      await db
        .delete(walletLocks)
        .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
    });
  });

  describe("Session Management", () => {
    it("should initialize session with chain nonce", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(42);

      const { session, validation } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      expect(session.walletAddress).toBe(TEST_WALLET_NORMALIZED);
      expect(session.chainId).toBe(TEST_CHAIN_ID);
      expect(session.executionId).toBe(testExecutionId);
      expect(session.currentNonce).toBe(42);
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(validation.chainNonce).toBe(42);

      await manager.endSession(session);
    });

    it("should increment nonce correctly with getNextNonce", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(10);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      // Get sequential nonces
      const nonce1 = manager.getNextNonce(session);
      const nonce2 = manager.getNextNonce(session);
      const nonce3 = manager.getNextNonce(session);

      expect(nonce1).toBe(10);
      expect(nonce2).toBe(11);
      expect(nonce3).toBe(12);
      expect(session.currentNonce).toBe(13); // Next available

      await manager.endSession(session);
    });
  });

  describe("Transaction Recording", () => {
    it("should record transaction in database", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(5);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      const nonce = manager.getNextNonce(session);
      const txHash = `0x${"a".repeat(64)}`;

      await manager.recordTransaction(
        session,
        nonce,
        txHash,
        "workflow_123",
        "1000000000" // 1 gwei
      );

      // Verify in database
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, txHash));

      expect(transactions.length).toBe(1);
      expect(transactions[0].walletAddress).toBe(TEST_WALLET_NORMALIZED);
      expect(transactions[0].chainId).toBe(TEST_CHAIN_ID);
      expect(transactions[0].nonce).toBe(nonce);
      expect(transactions[0].executionId).toBe(testExecutionId);
      expect(transactions[0].workflowId).toBe("workflow_123");
      expect(transactions[0].gasPrice).toBe("1000000000");
      expect(transactions[0].status).toBe("pending");

      await manager.endSession(session);
    });

    it("should update transaction on conflict (same wallet/chain/nonce)", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(5);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      const nonce = manager.getNextNonce(session);
      const txHash1 = `0x${"b".repeat(64)}`;
      const txHash2 = `0x${"c".repeat(64)}`;

      // Record first transaction
      await manager.recordTransaction(session, nonce, txHash1);

      // Record replacement transaction with same nonce
      await manager.recordTransaction(
        session,
        nonce,
        txHash2,
        undefined,
        "2000000000"
      );

      // Should have updated, not created duplicate
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(
          and(
            eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED),
            eq(pendingTransactions.chainId, TEST_CHAIN_ID),
            eq(pendingTransactions.nonce, nonce)
          )
        );

      expect(transactions.length).toBe(1);
      expect(transactions[0].txHash).toBe(txHash2);
      expect(transactions[0].gasPrice).toBe("2000000000");

      await manager.endSession(session);
    });

    it("should confirm transaction", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider(5);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      const nonce = manager.getNextNonce(session);
      const txHash = `0x${"d".repeat(64)}`;

      await manager.recordTransaction(session, nonce, txHash);

      // Confirm the transaction
      await manager.confirmTransaction(txHash);

      // Verify status updated
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, txHash));

      expect(transactions.length).toBe(1);
      expect(transactions[0].status).toBe("confirmed");
      expect(transactions[0].confirmedAt).toBeInstanceOf(Date);

      await manager.endSession(session);
    });
  });

  describe("Validation and Reconciliation", () => {
    it("should reconcile confirmed transactions on session start", async () => {
      // Pre-seed a "pending" transaction that's actually confirmed on chain
      const oldTxHash = `0x${"e".repeat(64)}`;
      await db.insert(pendingTransactions).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        nonce: 3, // Less than chain nonce (5)
        txHash: oldTxHash,
        executionId: "old_execution",
        status: "pending",
      });

      // Create provider that shows nonce 5 and returns receipt for the old tx
      const provider = {
        getTransactionCount: () => Promise.resolve(5),
        getTransactionReceipt: (hash: string) => {
          if (hash === oldTxHash) {
            return Promise.resolve({ blockNumber: 12_345 }); // Confirmed
          }
          return Promise.resolve(null);
        },
        getTransaction: () => Promise.resolve(null),
      };

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      expect(validation.chainNonce).toBe(5);
      expect(validation.reconciledCount).toBe(1);

      // Verify transaction was marked as confirmed
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, oldTxHash));

      expect(transactions[0].status).toBe("confirmed");

      await manager.endSession(session);
    });

    it("should detect replaced transactions", async () => {
      // Pre-seed a "pending" transaction that was replaced
      const replacedTxHash = `0x${"f".repeat(64)}`;
      await db.insert(pendingTransactions).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        nonce: 4, // Less than chain nonce (5)
        txHash: replacedTxHash,
        executionId: "replaced_execution",
        status: "pending",
      });

      // Provider shows nonce 5 but no receipt for replaced tx
      const provider = {
        getTransactionCount: async () => 5,
        getTransactionReceipt: async () => null, // Not found = replaced
        getTransaction: async () => null,
      };

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      expect(validation.reconciledCount).toBe(1);
      expect(
        validation.warnings.some((w) => w.includes("replaced or dropped"))
      ).toBe(true);

      // Verify transaction was marked as replaced
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, replacedTxHash));

      expect(transactions[0].status).toBe("replaced");

      await manager.endSession(session);
    });

    it("should detect dropped mempool transactions", async () => {
      // Pre-seed a "pending" transaction with current nonce that's no longer in mempool
      const droppedTxHash = `0x${"1".repeat(64)}`;
      await db.insert(pendingTransactions).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        nonce: 5, // Same as chain nonce
        txHash: droppedTxHash,
        executionId: "dropped_execution",
        status: "pending",
        submittedAt: new Date(Date.now() - 60_000), // 1 minute ago
      });

      // Provider shows nonce 5 and tx not in mempool
      const provider = {
        getTransactionCount: async () => 5,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null, // Not in mempool
      };

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      expect(validation.reconciledCount).toBe(1);
      expect(
        validation.warnings.some((w) => w.includes("dropped from mempool"))
      ).toBe(true);

      // Verify transaction was marked as dropped
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, droppedTxHash));

      expect(transactions[0].status).toBe("dropped");

      await manager.endSession(session);
    });

    it("should warn about still-pending mempool transactions", async () => {
      // Pre-seed a "pending" transaction with current nonce that's still in mempool
      const pendingTxHash = `0x${"2".repeat(64)}`;
      await db.insert(pendingTransactions).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        nonce: 5, // Same as chain nonce
        txHash: pendingTxHash,
        executionId: "pending_execution",
        status: "pending",
        submittedAt: new Date(Date.now() - 30_000), // 30 seconds ago
      });

      // Provider shows nonce 5 and tx IS in mempool
      const provider = {
        getTransactionCount: async () => 5,
        getTransactionReceipt: async () => null,
        getTransaction: async () => ({ hash: pendingTxHash }), // Still in mempool
      };

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      // Should NOT be reconciled (still pending)
      expect(validation.reconciledCount).toBe(0);
      expect(
        validation.warnings.some((w) => w.includes("still pending in mempool"))
      ).toBe(true);

      // Transaction status should remain pending
      const transactions = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, pendingTxHash));

      expect(transactions[0].status).toBe("pending");

      await manager.endSession(session);
    });
  });

  describe("Expired Lock Takeover", () => {
    it("should take over an expired lock and allow new session", async () => {
      // Insert a lock whose expires_at is in the past — any caller can take it.
      await db.insert(walletLocks).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        lockedBy: "stale_execution",
        lockedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      });

      const manager = new NonceManager({
        lockTtlMs: 60_000,
        maxLockRetries: 3,
        lockRetryDelayMs: 100,
      });
      const provider = createMockProvider(5);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );

      // Should have acquired lock despite stale lock
      expect(session.executionId).toBe(testExecutionId);

      // Verify new lock holder
      const locks = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locks[0].lockedBy).toBe(testExecutionId);

      await manager.endSession(session);
    }, 15_000);
  });

  describe("TTL-based Lock Recovery", () => {
    it("recovers a wedged lock once expires_at passes (no live holder needed)", async () => {
      // Simulate a crashed holder: row exists with locked_by set but
      // expires_at already in the past. With the old advisory-lock model
      // this could only be cleared by closing the holder's connection.
      await db.insert(walletLocks).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        lockedBy: `${testExecutionId}_crash`,
        lockedAt: new Date(Date.now() - 10_000),
        expiresAt: new Date(Date.now() - 1000),
      });

      const manager = new NonceManager({
        maxLockRetries: 3,
        lockRetryDelayMs: 50,
      });
      const provider = createMockProvider(5);

      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_recovery`,
        provider as any
      );

      expect(session.executionId).toBe(`${testExecutionId}_recovery`);

      const locksAfter = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );
      expect(locksAfter[0]?.lockedBy).toBe(`${testExecutionId}_recovery`);

      await manager.endSession(session);
    }, 15_000);

    it("blocks concurrent sessions on the same wallet+chain until release", async () => {
      const manager1 = new NonceManager();
      const manager2 = new NonceManager({
        maxLockRetries: 5,
        lockRetryDelayMs: 100,
      });
      const provider = createMockProvider(5);

      const { session: session1 } = await manager1.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_holder`,
        provider as any
      );

      const session2Promise = manager2.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_waiter`,
        provider as any
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      await manager1.endSession(session1);

      const { session: session2 } = await session2Promise;
      expect(session2.executionId).toBe(`${testExecutionId}_waiter`);

      await manager2.endSession(session2);
    }, 15_000);

    it("fails to acquire if holder never releases and TTL has not expired", async () => {
      const manager1 = new NonceManager();
      const manager2 = new NonceManager({
        maxLockRetries: 3,
        lockRetryDelayMs: 50,
        lockTtlMs: 60_000,
      });
      const provider = createMockProvider(5);

      const { session: session1 } = await manager1.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_blocker`,
        provider as any
      );

      await expect(
        manager2.startSession(
          TEST_WALLET,
          TEST_CHAIN_ID,
          `${testExecutionId}_blocked`,
          provider as any
        )
      ).rejects.toThrow(FAILED_LOCK_REGEX);

      await manager1.endSession(session1);
    }, 15_000);

    it("waits past the plain budget only while a bundle holds the wallet, until its longest hold ends", async () => {
      const holder = new NonceManager();
      const provider = {
        ...createMockProvider(5),
        getBlockNumber: async () => 50,
      };
      const holderId = `${testExecutionId}_bundle`;
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        holderId,
        provider as any
      );
      // The hold ends at most LONGEST_BUNDLE_HOLD_MS after the lock, plus the waiter's margin.
      const lockedAt = new Date(
        Date.now() - LONGEST_BUNDLE_HOLD_MS - 8000 + 1500
      );
      await db
        .update(walletLocks)
        .set({ lockedAt })
        .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
      const waiter = () =>
        new NonceManager({
          maxLockRetries: 3,
          lockRetryDelayMs: 50,
        }).startSession(
          TEST_WALLET,
          TEST_CHAIN_ID,
          `${testExecutionId}_waiter`,
          provider as any
        );

      // A plain holder: the waiter gives up after its own short budget.
      await expect(waiter()).rejects.toThrow(FAILED_LOCK_REGEX);

      await holder.recordBundle(session, 5, {
        hashes: [`0x${"ab".repeat(32)}`],
        lastTargetBlock: 100,
        workflowId: "wf_bundle",
      });
      const waiting = waiter();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await holder.endSession(session);
      const { session: next } = await waiting;
      expect(next.executionId).toBe(`${testExecutionId}_waiter`);
      await new NonceManager().endSession(next);
    }, 15_000);

    // The holder took the lock so long ago that its pre-record budget (plus the margin) ends in about 1.5 s.
    const preparingHolder = async (suffix: string) => {
      const holder = new NonceManager();
      const provider = {
        ...createMockProvider(5),
        getBlockNumber: async () => 50,
      };
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_${suffix}`,
        provider as any
      );
      await db
        .update(walletLocks)
        .set({
          lockedAt: new Date(Date.now() - BUNDLE_PRE_RECORD_MS - 8000 + 1500),
        })
        .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
      // The wallet sent a bundle here before, so a young holder may be preparing one.
      await db.insert(pendingTransactions).values({
        walletAddress: TEST_WALLET_NORMALIZED,
        chainId: TEST_CHAIN_ID,
        nonce: 1,
        txHash: `0x${"a1".repeat(32)}`,
        executionId: `${testExecutionId}_earlier`,
        status: "confirmed",
        bundleRuns: [
          {
            executionId: `${testExecutionId}_earlier`,
            hashes: [`0x${"a1".repeat(32)}`],
            signedAt: Date.now(),
          },
        ],
      });
      const waiter = () =>
        new NonceManager({
          maxLockRetries: 3,
          lockRetryDelayMs: 50,
        }).startSession(
          TEST_WALLET,
          TEST_CHAIN_ID,
          `${testExecutionId}_waiter`,
          provider as any
        );
      return { holder, session, waiter };
    };

    it("waits for a holder still preparing, then out its hold once it recorded a bundle", async () => {
      const { holder, session, waiter } = await preparingHolder("preparing");
      const waiting = waiter();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.recordBundle(session, 5, {
        hashes: [`0x${"ab".repeat(32)}`],
        lastTargetBlock: 100,
        workflowId: "wf_bundle",
      });
      // Past the preparing wait: only the hold behind the bundle keeps the waiter.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await holder.endSession(session);
      const { session: next } = await waiting;
      expect(next.executionId).toBe(`${testExecutionId}_waiter`);
      await new NonceManager().endSession(next);
    }, 15_000);

    it("fails after waiting for a holder still preparing that recorded no bundle", async () => {
      const { holder, session, waiter } = await preparingHolder("plain");
      const started = Date.now();
      await expect(waiter()).rejects.toThrow(FAILED_LOCK_REGEX);
      expect(Date.now() - started).toBeGreaterThan(1000);
      await holder.endSession(session);
    }, 15_000);

    it("does not wait for a young holder on a wallet that sent no bundle here", async () => {
      const { holder, session, waiter } = await preparingHolder("nobundles");
      await db
        .delete(pendingTransactions)
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      const started = Date.now();
      await expect(waiter()).rejects.toThrow(FAILED_LOCK_REGEX);
      expect(Date.now() - started).toBeLessThan(1000);
      await holder.endSession(session);
    }, 15_000);

    it("does not wait behind a stale bundle row the holder's run recorded before this lock", async () => {
      const holderId = `${testExecutionId}_stale`;
      const holder = new NonceManager();
      const provider = {
        ...createMockProvider(5),
        getBlockNumber: async () => 50,
      };
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        holderId,
        provider as any
      );
      await holder.recordBundle(session, 5, {
        hashes: [`0x${"ac".repeat(32)}`],
        lastTargetBlock: 100,
        workflowId: "wf_bundle",
      });
      // An earlier step's row: recorded a minute before this lock was taken.
      await db
        .update(pendingTransactions)
        .set({ submittedAt: new Date(Date.now() - 60_000) })
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      await db
        .update(walletLocks)
        .set({ lockedAt: new Date(Date.now() - BUNDLE_PRE_RECORD_MS - 10_000) })
        .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
      const started = Date.now();
      await expect(
        new NonceManager({
          maxLockRetries: 3,
          lockRetryDelayMs: 50,
        }).startSession(
          TEST_WALLET,
          TEST_CHAIN_ID,
          `${testExecutionId}_waiter`,
          provider as any
        )
      ).rejects.toThrow(FAILED_LOCK_REGEX);
      expect(Date.now() - started).toBeLessThan(1000);
      await holder.endSession(session);
    }, 15_000);
  });

  // The unit suite drives the heartbeat against a mocked db, so it can only
  // prove the handler reacts to what the UPDATE returned. These run the fence
  // itself: the lock row, the takeover, and the beat are all real.
  describe("Heartbeat", () => {
    const SHORT_TTL_MS = 1000;

    async function readLock() {
      const [row] = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );
      return row;
    }

    function sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it("keeps the lock past its TTL while the holder beats, so nobody else can take it", async () => {
      const holder = new NonceManager({ lockTtlMs: SHORT_TTL_MS });
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_beating`,
        createMockProvider(5) as any
      );
      const firstExpiry = (await readLock())?.expiresAt;

      // Well past the TTL: without the heartbeat the row would be takeable.
      await sleep(SHORT_TTL_MS * 1.5);

      const renewed = await readLock();
      expect(renewed?.lockedBy).toBe(`${testExecutionId}_beating`);
      expect(renewed?.expiresAt.getTime()).toBeGreaterThan(
        firstExpiry?.getTime() ?? 0
      );
      expect(renewed?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(session.lost).toBe(false);

      const taker = new NonceManager({
        lockTtlMs: SHORT_TTL_MS,
        maxLockRetries: 3,
        lockRetryDelayMs: 50,
      });
      await expect(
        taker.startSession(
          TEST_WALLET,
          TEST_CHAIN_ID,
          `${testExecutionId}_denied`,
          createMockProvider(5) as any
        )
      ).rejects.toThrow(FAILED_LOCK_REGEX);

      await holder.endSession(session);
    }, 20_000);

    it("lets a second manager take over once the holder stops beating", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const holder = new NonceManager({ lockTtlMs: SHORT_TTL_MS });
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_dying`,
        createMockProvider(5) as any
      );
      const timer = setIntervalSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      setIntervalSpy.mockRestore();

      // The holder's process dies: the interval never fires again and nothing
      // renews expires_at.
      clearInterval(timer);
      await sleep(SHORT_TTL_MS * 1.5);

      const taker = new NonceManager({
        lockTtlMs: SHORT_TTL_MS,
        maxLockRetries: 20,
        lockRetryDelayMs: 50,
      });
      const { session: takerSession } = await taker.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_heir`,
        createMockProvider(5) as any
      );
      expect((await readLock())?.lockedBy).toBe(`${testExecutionId}_heir`);

      // The dead holder coming back to release must not clear the new holder.
      await holder.endSession(session);
      expect((await readLock())?.lockedBy).toBe(`${testExecutionId}_heir`);

      await taker.endSession(takerSession);
    }, 20_000);

    it("cannot revive a lock another execution has taken over, and hands out no more nonces", async () => {
      const holder = new NonceManager({ lockTtlMs: SHORT_TTL_MS });
      const { session } = await holder.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_loser`,
        createMockProvider(5) as any
      );

      // Someone else now owns the row, with an expiry far beyond the holder's.
      const usurperExpiry = new Date(Date.now() + 60_000);
      await db
        .update(walletLocks)
        .set({
          lockedBy: `${testExecutionId}_usurper`,
          lockedAt: new Date(),
          expiresAt: usurperExpiry,
        })
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      // Give the holder several beats to try to extend what it no longer holds.
      await sleep(SHORT_TTL_MS);

      const row = await readLock();
      expect(row?.lockedBy).toBe(`${testExecutionId}_usurper`);
      expect(row?.expiresAt.getTime()).toBe(usurperExpiry.getTime());
      expect(session.lost).toBe(true);
      expect(() => holder.getNextNonce(session)).toThrow(NonceLockLostError);

      await holder.endSession(session);
      expect((await readLock())?.lockedBy).toBe(`${testExecutionId}_usurper`);

      await db
        .update(walletLocks)
        .set({ lockedBy: null, lockedAt: null })
        .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
    }, 20_000);
  });

  // Several hashes at one nonce (one per bundle target block), and rows that
  // are never in the public mempool while their window is open.
  describe("Bundle rows", () => {
    const hash = (c: string): string => `0x${c.repeat(64)}`;

    type ChainView = {
      transactionCount: number;
      latestBlock: number | "unreadable";
      mined?: string[];
      inMempool?: string[];
    };

    function chainProvider(view: ChainView) {
      const calls = { getTransaction: 0, getBlockNumber: 0 };
      const provider = {
        getTransactionCount: async () => view.transactionCount,
        getBlockNumber: async () => {
          calls.getBlockNumber += 1;
          if (view.latestBlock === "unreadable") {
            throw new Error("block number read failed");
          }
          return view.latestBlock;
        },
        getTransactionReceipt: async (h: string) =>
          view.mined?.includes(h) ? { hash: h, status: 1 } : null,
        getTransaction: async (h: string) => {
          calls.getTransaction += 1;
          return view.inMempool?.includes(h) ? { hash: h } : null;
        },
      };
      return { provider, calls };
    }

    async function rowAt(nonce: number) {
      const [row] = await db
        .select()
        .from(pendingTransactions)
        .where(
          and(
            eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED),
            eq(pendingTransactions.chainId, TEST_CHAIN_ID),
            eq(pendingTransactions.nonce, nonce)
          )
        );
      return row;
    }

    async function seedBundle(
      nonce: number,
      hashes: string[],
      lastTargetBlock: number
    ): Promise<void> {
      const manager = new NonceManager();
      // Chain nonce 0 and block 0: earlier seeded rows stay untouched.
      const { provider } = chainProvider({
        transactionCount: 0,
        latestBlock: 0,
      });
      const { session } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_seed`,
        provider as any
      );
      await manager.recordBundle(session, nonce, {
        hashes,
        lastTargetBlock,
        workflowId: "wf_bundle",
        gasPrice: "3000000000",
      });
      await manager.endSession(session);
    }

    async function startAgainst(view: ChainView) {
      const manager = new NonceManager();
      const { provider, calls } = chainProvider(view);
      const started = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        provider as any
      );
      return { manager, calls, ...started };
    }

    it("records every hash before the send, the first as tx_hash, with its window", async () => {
      await seedBundle(7, [hash("1"), hash("2"), hash("3")], 103);
      const row = await rowAt(7);
      expect(row).toMatchObject({
        txHash: hash("1"),
        lastTargetBlock: 103,
        status: "pending",
        workflowId: "wf_bundle",
        bundleRuns: [
          {
            executionId: `${testExecutionId}_seed`,
            hashes: [hash("1"), hash("2"), hash("3")],
            signedAt: expect.any(Number),
          },
        ],
      });
    });

    it("confirms a past nonce through the hash that was mined (not the first)", async () => {
      await seedBundle(7, [hash("1"), hash("2"), hash("3")], 103);
      const { manager, session } = await startAgainst({
        transactionCount: 8,
        latestBlock: 104,
        mined: [hash("2")],
      });
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
      await manager.endSession(session);
    });

    it("marks a past nonce replaced when none of its hashes was mined", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      // Replaced needs the row's age too (provedReplaced), as in the sweep.
      await db
        .update(pendingTransactions)
        .set({ submittedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      const { manager, session } = await startAgainst({
        transactionCount: 8,
        latestBlock: 104,
      });
      expect((await rowAt(7))?.status).toBe("replaced");
      await manager.endSession(session);
    });

    it("marks a fresh past nonce dropped, not replaced, when none of its hashes was mined yet", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      const { manager, session } = await startAgainst({
        transactionCount: 8,
        latestBlock: 104,
      });
      expect((await rowAt(7))?.status).toBe("dropped");
      await manager.endSession(session);
    });

    it("leaves a row pending up to its last target block plus a 2-block margin, without a mempool read", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      const { manager, session, calls, validation } = await startAgainst({
        transactionCount: 7,
        latestBlock: 105,
      });
      expect((await rowAt(7))?.status).toBe("pending");
      expect(calls.getTransaction).toBe(0);
      expect(validation.warnings.join(" ")).toContain("until block 103");
      // A live row is never handed out again.
      expect(session.currentNonce).toBe(8);
      await manager.endSession(session);
    });

    it("drops the row once the latest block passes the window and no hash was mined, and the nonce is reused", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      const { manager, session, calls } = await startAgainst({
        transactionCount: 7,
        latestBlock: 106,
      });
      expect((await rowAt(7))?.status).toBe("dropped");
      // A bundle is never in a mempool: no mempool read decides it.
      expect(calls.getTransaction).toBe(0);
      expect(session.currentNonce).toBe(7);
      await manager.endSession(session);
    });

    it("confirms a row whose window passed when a hash was mined, even if the nonce endpoint lags", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      const { manager, session } = await startAgainst({
        transactionCount: 7,
        latestBlock: 106,
        mined: [hash("2")],
      });
      expect(await rowAt(7)).toMatchObject({
        status: "confirmed",
        txHash: hash("2"),
      });
      await manager.endSession(session);
    });

    it("caps the window by time, so an absurd last target block cannot pin the nonce", async () => {
      await seedBundle(7, [hash("1")], 10_000_000);
      await db
        .update(pendingTransactions)
        .set({ submittedAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      const { manager, session, calls } = await startAgainst({
        transactionCount: 7,
        latestBlock: 150,
      });
      expect((await rowAt(7))?.status).toBe("dropped");
      expect(calls.getBlockNumber).toBe(0);
      expect(session.currentNonce).toBe(7);
      await manager.endSession(session);
    });

    it("keeps a bundle row pending when the latest block cannot be read, and the session still starts", async () => {
      await seedBundle(7, [hash("1")], 103);
      const { manager, session, validation } = await startAgainst({
        transactionCount: 7,
        latestBlock: "unreadable",
      });
      expect((await rowAt(7))?.status).toBe("pending");
      expect(validation.warnings.join(" ")).toContain(
        "latest block could not be read"
      );
      expect(session.currentNonce).toBe(8);
      await manager.endSession(session);
    });

    it("never reads the latest block without a bundle row, so a failing read cannot stop a session", async () => {
      const { manager, session, calls } = await startAgainst({
        transactionCount: 7,
        latestBlock: "unreadable",
      });
      expect(calls.getBlockNumber).toBe(0);
      expect(session.currentNonce).toBe(7);
      await manager.endSession(session);
    });

    it("applies the window to a future-nonce row too", async () => {
      await seedBundle(9, [hash("4")], 200);
      const { manager, session, calls } = await startAgainst({
        transactionCount: 7,
        latestBlock: 150,
      });
      expect((await rowAt(9))?.status).toBe("pending");
      expect(calls.getTransaction).toBe(0);
      expect(session.currentNonce).toBe(10);
      await manager.endSession(session);
    });

    it("reads the latest block once for several windowed rows, and not at all without one", async () => {
      await seedBundle(7, [hash("1")], 300);
      await seedBundle(8, [hash("2")], 300);
      const first = await startAgainst({
        transactionCount: 7,
        latestBlock: 150,
      });
      expect(first.calls.getBlockNumber).toBe(1);
      await first.manager.endSession(first.session);

      await db
        .delete(pendingTransactions)
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      const second = await startAgainst({
        transactionCount: 7,
        latestBlock: 150,
      });
      expect(second.calls.getBlockNumber).toBe(0);
      await second.manager.endSession(second.session);
    });

    it("confirmNonce sets the mined hash; markNonceDropped frees the nonce for the next session", async () => {
      const { manager, session } = await startAgainst({
        transactionCount: 7,
        latestBlock: 100,
      });
      const nonce = manager.getNextNonce(session);
      await manager.recordBundle(session, nonce, {
        hashes: [hash("5"), hash("6")],
        lastTargetBlock: 102,
      });
      await manager.confirmNonce(session, nonce, hash("6"));
      expect(await rowAt(nonce)).toMatchObject({
        status: "confirmed",
        txHash: hash("6"),
      });

      const next = manager.getNextNonce(session);
      await manager.recordBundle(session, next, {
        hashes: [hash("7")],
        lastTargetBlock: 102,
      });
      await manager.markNonceDropped(session, next);
      expect((await rowAt(next))?.status).toBe("dropped");
      await manager.endSession(session);

      // Chain nonce 8 (7 mined): the dropped 8 is handed out again.
      const again = await startAgainst({
        transactionCount: 8,
        latestBlock: 110,
      });
      expect(again.session.currentNonce).toBe(8);
      await again.manager.endSession(again.session);
    });

    it("markNonceDropped leaves another execution's row alone", async () => {
      await seedBundle(7, [hash("1")], 103);
      const { manager, session } = await startAgainst({
        transactionCount: 7,
        latestBlock: 100,
      });
      await manager.markNonceDropped(session, 7);
      expect((await rowAt(7))?.status).toBe("pending");
      await manager.endSession(session);
    });

    it("records a public or relay send with no route or window: it keeps today's rules", async () => {
      const { manager, session } = await startAgainst({
        transactionCount: 7,
        latestBlock: 100,
      });
      const nonce = manager.getNextNonce(session);
      await manager.recordTransaction(session, nonce, hash("8"), "wf", "1");
      expect(await rowAt(nonce)).toMatchObject({
        lastTargetBlock: null,
        bundleRuns: [],
      });
      await manager.endSession(session);

      // Not in the mempool on the next session: dropped at once, as before.
      const next = await startAgainst({
        transactionCount: 7,
        latestBlock: 100,
      });
      expect((await rowAt(nonce))?.status).toBe("dropped");
      await next.manager.endSession(next.session);
    });

    it("a send over a row that is not a dropped bundle starts a fresh row", async () => {
      await seedBundle(7, [hash("1"), hash("2")], 103);
      await db
        .update(pendingTransactions)
        .set({ status: "replaced" })
        .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
      const { manager, session } = await startAgainst({
        transactionCount: 7,
        latestBlock: 104,
      });
      await manager.recordTransaction(session, 7, hash("9"));
      expect(await rowAt(7)).toMatchObject({
        txHash: hash("9"),
        lastTargetBlock: null,
        bundleRuns: [],
        status: "pending",
        executionId: testExecutionId,
      });
      await manager.endSession(session);
    });
  });
});
