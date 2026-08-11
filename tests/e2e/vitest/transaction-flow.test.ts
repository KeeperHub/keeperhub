/**
 * E2E Tests for Transaction Flow Integration
 *
 * These tests verify the complete transaction management flow:
 * - Nonce session with gas strategy integration
 * - Multi-transaction workflows
 * - Transaction lifecycle (pending -> confirmed/replaced/dropped)
 * - Error handling and recovery
 *
 * Prerequisites:
 * - Database running with nonce manager tables
 * - Network access to RPC endpoints
 * - Run: pnpm db:push
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
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
vi.mock("server-only", () => ({}));

import { pendingTransactions, walletLocks } from "@/lib/db/schema-extensions";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { AdaptiveGasStrategy, resetGasStrategy } from "@/lib/web3/gas-strategy";
import { NonceManager, resetNonceManager } from "@/lib/web3/nonce-manager";

// Skip if infrastructure not available
const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

// Test configuration
const TEST_WALLET = "0xTestWallet1234567890123456789012345678";
const TEST_WALLET_NORMALIZED = TEST_WALLET.toLowerCase();
const TEST_CHAIN_ID = 11_155_111; // Sepolia
const SEPOLIA_RPC = getRpcUrlByChainId(11_155_111, "primary");
const SEPOLIA_FALLBACK_RPC = getRpcUrlByChainId(11_155_111, "fallback");

// Build a failover-aware Sepolia manager. Each describe block reuses this
// shape: construct a manager, take its current primary as the
// ethers.JsonRpcProvider that library calls (NonceManager startSession, etc.)
// need, and route explicit reads in this test through
// manager.executeWithFailover so a primary-endpoint hiccup falls back to
// the configured secondary.
async function buildSepoliaManager(): Promise<RpcProviderManager> {
  return getRpcProviderFromUrls(
    SEPOLIA_RPC,
    SEPOLIA_FALLBACK_RPC,
    TEST_CHAIN_ID,
    "sepolia"
  );
}

describe.skipIf(shouldSkip)("Transaction Flow E2E", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let sepoliaManager: RpcProviderManager;
  let sepoliaProvider: ethers.JsonRpcProvider;
  let testExecutionId: string;

  beforeAll(async () => {
    // Connect to database
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5433/KEEP-1240";

    client = postgres(connectionString, { max: 5 });
    db = drizzle(client);

    // Initialize RPC provider via failover manager
    sepoliaManager = await buildSepoliaManager();
    sepoliaProvider = sepoliaManager.getProvider();

    // Verify connectivity through failover so a primary-endpoint blip falls
    // through to the configured secondary instead of triggering the
    // "RPC not available" branch.
    try {
      await sepoliaManager.executeWithFailover((p) => p.getBlockNumber());
    } catch (_error) {
      console.warn("Sepolia RPC not available");
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
    // Reset singletons
    resetNonceManager();
    resetGasStrategy();

    // Generate unique execution ID
    testExecutionId = `test_flow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Clean up test data
    await db
      .delete(pendingTransactions)
      .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
  });

  describe("Integrated Nonce + Gas Strategy", () => {
    it("should get nonce session with gas config for transaction", async () => {
      const nonceManager = new NonceManager();
      const gasStrategy = new AdaptiveGasStrategy();

      // Create mock provider that returns controlled nonce
      const mockNonce = 10;
      const mockProvider = {
        getTransactionCount: async () => mockNonce,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
        // Forward gas-related calls to real provider
        send: async (method: string, params: unknown[]) =>
          await sepoliaProvider.send(method, params),
        getFeeData: async () => await sepoliaProvider.getFeeData(),
      };

      // Start nonce session
      const { session, validation } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      expect(session.currentNonce).toBe(mockNonce);
      expect(validation.chainNonce).toBe(mockNonce);

      // Get gas config for transaction. Pass the failover manager so the
      // gas strategy's internal RPC calls (fee history, getFeeData) route
      // through executeWithFailover instead of dialing the primary directly.
      const gasConfig = await gasStrategy.getGasConfig(
        sepoliaProvider,
        BigInt(21_000),
        TEST_CHAIN_ID,
        undefined,
        undefined,
        sepoliaManager
      );

      expect(gasConfig.gasLimit).toBeGreaterThan(BigInt(21_000));
      expect(gasConfig.maxFeePerGas).toBeGreaterThan(BigInt(0));

      // Simulate transaction preparation
      const nonce = nonceManager.getNextNonce(session);
      expect(nonce).toBe(mockNonce);

      // Record simulated transaction
      const txHash = `0x${"abc".repeat(21)}1`;
      await nonceManager.recordTransaction(
        session,
        nonce,
        txHash,
        "test_workflow",
        gasConfig.maxFeePerGas.toString()
      );

      // Verify recorded in database
      const recorded = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, txHash));

      expect(recorded.length).toBe(1);
      expect(recorded[0].nonce).toBe(nonce);
      expect(recorded[0].gasPrice).toBe(gasConfig.maxFeePerGas.toString());

      await nonceManager.endSession(session);
    }, 30_000);

    it("should handle multi-transaction workflow with sequential nonces", async () => {
      const nonceManager = new NonceManager();
      const gasStrategy = new AdaptiveGasStrategy();

      const mockProvider = {
        getTransactionCount: async () => 5,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
        send: async (method: string, params: unknown[]) =>
          sepoliaProvider.send(method, params),
        getFeeData: async () => sepoliaProvider.getFeeData(),
      };

      const { session } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      // Simulate 3 transactions in a workflow
      const txHashes: string[] = [];
      const nonces: number[] = [];

      for (let i = 0; i < 3; i++) {
        const nonce = nonceManager.getNextNonce(session);
        nonces.push(nonce);

        const gasConfig = await gasStrategy.getGasConfig(
          sepoliaProvider,
          BigInt(50_000 + i * 10_000), // Varying gas
          TEST_CHAIN_ID,
          undefined,
          undefined,
          sepoliaManager
        );

        const txHash = `0x${"def".repeat(21)}${i}`;
        txHashes.push(txHash);

        await nonceManager.recordTransaction(
          session,
          nonce,
          txHash,
          "multi_tx_workflow",
          gasConfig.maxFeePerGas.toString()
        );
      }

      // Verify sequential nonces
      expect(nonces).toEqual([5, 6, 7]);

      // Verify all transactions recorded
      const recorded = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.executionId, testExecutionId));

      expect(recorded.length).toBe(3);

      // Simulate confirmations
      for (const txHash of txHashes) {
        await nonceManager.confirmTransaction(txHash);
      }

      // Verify all confirmed
      const confirmed = await db
        .select()
        .from(pendingTransactions)
        .where(
          and(
            eq(pendingTransactions.executionId, testExecutionId),
            eq(pendingTransactions.status, "confirmed")
          )
        );

      expect(confirmed.length).toBe(3);

      await nonceManager.endSession(session);
    }, 60_000);
  });

  describe("Session Management", () => {
    it("should properly start and end session with lock tracking", async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: async () => 15,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
      };

      // Start session
      const { session, validation } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      // Verify session properties
      expect(session.walletAddress).toBe(TEST_WALLET_NORMALIZED);
      expect(session.currentNonce).toBe(15);
      expect(validation.chainNonce).toBe(15);

      // Verify lock is tracked in database
      const locksActive = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locksActive.length).toBe(1);
      expect(locksActive[0]?.lockedBy).toBe(testExecutionId);

      // End session
      await nonceManager.endSession(session);

      // Verify lock is released
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
      expect(locksAfter[0]?.lockedBy).toBeNull();
    });
  });

  describe("Transaction Lifecycle", () => {
    it("should track full transaction lifecycle: pending -> confirmed", async () => {
      const nonceManager = new NonceManager();

      const mockProvider = {
        getTransactionCount: async () => 25,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
      };

      const { session } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      const nonce = nonceManager.getNextNonce(session);
      const txHash = `0x${"lifecycle".repeat(6)}1234`;

      // 1. Record as pending
      await nonceManager.recordTransaction(session, nonce, txHash);

      let tx = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, txHash));

      expect(tx[0].status).toBe("pending");
      expect(tx[0].confirmedAt).toBeNull();

      // 2. Confirm transaction
      await nonceManager.confirmTransaction(txHash);

      tx = await db
        .select()
        .from(pendingTransactions)
        .where(eq(pendingTransactions.txHash, txHash));

      expect(tx[0].status).toBe("confirmed");
      expect(tx[0].confirmedAt).toBeInstanceOf(Date);

      await nonceManager.endSession(session);
    });

    it("should handle transaction replacement (speed up)", async () => {
      const nonceManager = new NonceManager();

      const mockProvider = {
        getTransactionCount: async () => 30,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
      };

      const { session } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      const nonce = nonceManager.getNextNonce(session);
      const originalTxHash = `0x${"original".repeat(7)}12`;
      const replacementTxHash = `0x${"replaced".repeat(7)}12`;

      // 1. Record original transaction
      await nonceManager.recordTransaction(
        session,
        nonce,
        originalTxHash,
        "workflow",
        "1000000000" // 1 gwei
      );

      // 2. Record replacement (same nonce, higher gas)
      await nonceManager.recordTransaction(
        session,
        nonce,
        replacementTxHash,
        "workflow",
        "2000000000" // 2 gwei (speed up)
      );

      // Should update existing record (upsert on wallet/chain/nonce)
      const txs = await db
        .select()
        .from(pendingTransactions)
        .where(
          and(
            eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED),
            eq(pendingTransactions.chainId, TEST_CHAIN_ID),
            eq(pendingTransactions.nonce, nonce)
          )
        );

      expect(txs.length).toBe(1);
      expect(txs[0].txHash).toBe(replacementTxHash);
      expect(txs[0].gasPrice).toBe("2000000000");

      await nonceManager.endSession(session);
    });
  });

  describe("Error Recovery", () => {
    it("should recover from partial workflow failure", async () => {
      const nonceManager = new NonceManager();

      const mockProvider = {
        getTransactionCount: async () => 35,
        getTransactionReceipt: async () => null,
        getTransaction: async () => null,
      };

      const { session } = await nonceManager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        testExecutionId,
        mockProvider as any
      );

      // Record first transaction successfully
      const nonce1 = nonceManager.getNextNonce(session);
      const txHash1 = `0x${"success1".repeat(7)}12`;
      await nonceManager.recordTransaction(session, nonce1, txHash1);
      await nonceManager.confirmTransaction(txHash1);

      // Second transaction "fails" (but nonce was used)
      const nonce2 = nonceManager.getNextNonce(session);
      const txHash2 = `0x${"failed12".repeat(7)}12`;
      await nonceManager.recordTransaction(session, nonce2, txHash2);
      // Don't confirm - simulates transaction failure

      await nonceManager.endSession(session);

      // Start new session - should reconcile
      const mockProvider2 = {
        getTransactionCount: () => Promise.resolve(37), // Chain moved forward (both confirmed)
        getTransactionReceipt: (hash: string) => {
          if (hash === txHash1 || hash === txHash2) {
            return Promise.resolve({ blockNumber: 12_345 }); // Both actually confirmed
          }
          return Promise.resolve(null);
        },
        getTransaction: () => Promise.resolve(null),
      };

      resetNonceManager();
      const manager2 = new NonceManager();
      const { session: session2, validation } = await manager2.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_recovery`,
        mockProvider2 as any
      );

      // Should have reconciled the "failed" transaction
      expect(validation.reconciledCount).toBeGreaterThanOrEqual(1);

      // New nonce should be 37
      expect(session2.currentNonce).toBe(37);

      await manager2.endSession(session2);
    });
  });

  describe("Sequential Workflow Management", () => {
    it("should manage sequential workflows correctly", async () => {
      // NOTE: PostgreSQL advisory locks are connection-scoped. In a single-process
      // test environment with shared db connection, both managers can acquire locks.
      // This test verifies lock tracking and sequential session management.

      const manager = new NonceManager();
      const wf1TxHash = `0x${"wf1tx".repeat(12)}abc`;

      // After KEEP-348, validateAndReconcile runs before max(pending) is read.
      // The recorded tx at nonce 40 is "still pending in mempool" for the
      // duration of this test, so getTransaction must return a truthy response
      // for that hash. Otherwise the reconciler would correctly mark the row
      // dropped (matching its actual chain state) and workflow2 would reuse
      // nonce 40 instead of advancing to 41.
      const mockProvider = {
        getTransactionCount: async () => 40,
        getTransactionReceipt: async () => null,
        getTransaction: async (hash: string) =>
          hash === wf1TxHash ? { hash } : null,
      };

      // First workflow
      const { session: session1 } = await manager.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_workflow1`,
        mockProvider as any
      );

      // Verify lock ownership
      const locks = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locks[0]?.lockedBy).toBe(`${testExecutionId}_workflow1`);

      // Use nonces
      const nonce1 = manager.getNextNonce(session1);
      expect(nonce1).toBe(40);

      // Record transaction
      await manager.recordTransaction(session1, nonce1, wf1TxHash, "workflow1");

      // End first workflow
      await manager.endSession(session1);

      // Verify lock released
      const locksAfter = await db
        .select()
        .from(walletLocks)
        .where(
          and(
            eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED),
            eq(walletLocks.chainId, TEST_CHAIN_ID)
          )
        );

      expect(locksAfter[0]?.lockedBy).toBeNull();

      // Second workflow can now start
      resetNonceManager();
      const manager2 = new NonceManager();
      const { session: session2 } = await manager2.startSession(
        TEST_WALLET,
        TEST_CHAIN_ID,
        `${testExecutionId}_workflow2`,
        mockProvider as any
      );

      // DB-aware nonce selection: max(chainNonce=40, maxPendingDbNonce=40 + 1) = 41
      expect(session2.currentNonce).toBe(41);

      await manager2.endSession(session2);
    }, 15_000);
  });
});

describe.skipIf(shouldSkip)("Transaction Flow with Real RPC", () => {
  let sepoliaManager: RpcProviderManager;
  let sepoliaProvider: ethers.JsonRpcProvider;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testExecutionId: string;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5433/KEEP-1240";

    client = postgres(connectionString, { max: 5 });
    db = drizzle(client);
    sepoliaManager = await buildSepoliaManager();
    sepoliaProvider = sepoliaManager.getProvider();
  });

  afterAll(async () => {
    await db
      .delete(pendingTransactions)
      .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
    await client.end();
  });

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  beforeEach(async () => {
    resetNonceManager();
    resetGasStrategy();
    testExecutionId = `test_real_${Date.now()}`;

    await db
      .delete(pendingTransactions)
      .where(eq(pendingTransactions.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, TEST_WALLET_NORMALIZED));
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, ZERO_ADDRESS));
  });

  it("should get real chain nonce and gas prices", async () => {
    const nonceManager = new NonceManager();
    const gasStrategy = new AdaptiveGasStrategy();

    const { session, validation } = await nonceManager.startSession(
      ZERO_ADDRESS,
      TEST_CHAIN_ID,
      testExecutionId,
      sepoliaProvider as any
    );

    // Zero address should have nonce 0 (never sent transactions)
    expect(validation.chainNonce).toBe(0);
    expect(session.currentNonce).toBe(0);

    // Get real gas prices via the failover manager so the strategy's
    // internal fee-history calls retry against the secondary endpoint when
    // the primary hiccups.
    const gasConfig = await gasStrategy.getGasConfig(
      sepoliaProvider,
      BigInt(21_000),
      TEST_CHAIN_ID,
      undefined,
      undefined,
      sepoliaManager
    );

    expect(gasConfig.maxFeePerGas).toBeGreaterThan(BigInt(0));

    console.log("Real Sepolia gas prices:", {
      maxFeePerGas: `${ethers.formatUnits(gasConfig.maxFeePerGas, "gwei")} gwei`,
      maxPriorityFeePerGas: `${ethers.formatUnits(gasConfig.maxPriorityFeePerGas, "gwei")} gwei`,
    });

    await nonceManager.endSession(session);

    // Cleanup
    await db
      .delete(walletLocks)
      .where(eq(walletLocks.walletAddress, ZERO_ADDRESS));
  }, 30_000);
});
