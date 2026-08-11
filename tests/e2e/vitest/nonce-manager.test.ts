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
vi.unmock("server-only");

import { pendingTransactions, walletLocks } from "@/lib/db/schema-extensions";
import { NonceManager, resetNonceManager } from "@/lib/web3/nonce-manager";

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
  });
});
