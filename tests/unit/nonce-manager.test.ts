import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAILED_LOCK_REGEX =
  /Wallet is saturated: could not acquire the nonce lock/;

vi.mock("server-only", () => ({}));

const { mockSelect, mockInsert, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  pendingTransactions: {
    walletAddress: "wallet_address",
    chainId: "chain_id",
    nonce: "nonce",
    txHash: "tx_hash",
    executionId: "execution_id",
    workflowId: "workflow_id",
    gasPrice: "gas_price",
    status: "status",
  },
  walletLocks: {
    walletAddress: "wallet_address",
    chainId: "chain_id",
    lockedBy: "locked_by",
    lockedAt: "locked_at",
    expiresAt: "expires_at",
  },
}));

const { mockLogSystemError, mockLogSystemWarn, mockLogUserError, mockLogWarn } =
  vi.hoisted(() => ({
    mockLogSystemError: vi.fn(),
    mockLogSystemWarn: vi.fn(),
    mockLogUserError: vi.fn(),
    mockLogWarn: vi.fn(),
  }));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    INFRASTRUCTURE: "infrastructure",
    CONFIGURATION: "configuration",
  },
  logSystemError: mockLogSystemError,
  logSystemWarn: mockLogSystemWarn,
  logUserError: mockLogUserError,
  logWarn: mockLogWarn,
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  getNonceManager,
  NonceLockLostError,
  NonceManager,
  type NonceSession,
  resetNonceManager,
} from "@/lib/web3/nonce-manager";

function createMockProvider(
  options: {
    transactionCount?: number;
    transactionReceipt?: unknown;
    transaction?: unknown;
  } = {}
) {
  return {
    getTransactionCount: vi
      .fn()
      .mockResolvedValue(options.transactionCount ?? 5),
    getTransactionReceipt: vi
      .fn()
      .mockResolvedValue(options.transactionReceipt ?? null),
    getTransaction: vi.fn().mockResolvedValue(options.transaction ?? null),
  };
}

/**
 * Render a drizzle where-clause to its bound parameters, in order. The schema
 * is mocked to column-name strings above, so a fence such as
 * `eq(walletLocks.lockedBy, executionId)` renders as the pair
 * `["locked_by", executionId]`.
 */
function boundParams(where: unknown): unknown[] {
  return new PgDialect().sqlToQuery(where as SQL).params;
}

/**
 * Build a default chain of mocks for the row-based lock acquire path.
 * - INSERT ... ON CONFLICT DO NOTHING RETURNING — `insertedRows` controls
 *   how many rows the INSERT returned. 1 = lock acquired on insert.
 * - UPDATE ... WHERE locked_by IS NULL OR expires_at < NOW() RETURNING —
 *   `updatedRows` controls how many rows the UPDATE returned. 1 = lock
 *   acquired by taking over an unheld/expired row.
 * Both default to acquired-on-insert for happy-path tests.
 */
function setupLockMocks(
  opts: { insertedRows?: number; updatedRows?: number } = {}
) {
  const insertedRows = opts.insertedRows ?? 1;
  const updatedRows = opts.updatedRows ?? 0;

  mockInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue(insertedRows > 0 ? [{ walletAddress: "0x" }] : []),
      }),
      // recordTransaction uses onConflictDoUpdate
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });

  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue(updatedRows > 0 ? [{ walletAddress: "0x" }] : []),
      }),
    }),
  });
}

describe("NonceManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNonceManager();

    setupLockMocks();

    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
  });

  describe("constructor", () => {
    it("creates instance with default options", () => {
      const manager = new NonceManager();
      expect(manager).toBeInstanceOf(NonceManager);
    });

    it("accepts custom TTL and retry options", () => {
      const manager = new NonceManager({
        lockTtlMs: 30_000,
        maxLockRetries: 10,
        lockRetryDelayMs: 50,
      });
      expect(manager).toBeInstanceOf(NonceManager);
    });
  });

  describe("startSession", () => {
    it("acquires lock via INSERT and returns session with chain nonce", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider({ transactionCount: 10 });

      const { session, validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      expect(session.walletAddress).toBe(
        "0x1234567890123456789012345678901234567890"
      );
      expect(session.chainId).toBe(1);
      expect(session.executionId).toBe("exec_123");
      expect(session.currentNonce).toBe(10);
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(validation.chainNonce).toBe(10);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("acquires lock via UPDATE when an expired row already exists", async () => {
      // INSERT returns 0 rows (row exists), UPDATE returns 1 (we took over).
      setupLockMocks({ insertedRows: 0, updatedRows: 1 });

      const manager = new NonceManager();
      const provider = createMockProvider({ transactionCount: 10 });

      const { session } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_takeover",
        provider as unknown as import("ethers").Provider
      );

      expect(session.executionId).toBe("exec_takeover");
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("normalizes wallet address to lowercase", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider();

      const { session } = await manager.startSession(
        "0xABCDEF1234567890123456789012345678901234",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      expect(session.walletAddress).toBe(
        "0xabcdef1234567890123456789012345678901234"
      );
    });

    it("releases lock if RPC fails after acquire", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider();
      provider.getTransactionCount.mockRejectedValue(new Error("RPC error"));

      await expect(
        manager.startSession(
          "0x1234567890123456789012345678901234567890",
          1,
          "exec_123",
          provider as unknown as import("ethers").Provider
        )
      ).rejects.toThrow("RPC error");

      // Acquire (insert) + release (update) both ran.
      expect(mockInsert).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("throws and emits a metric when lock cannot be acquired", async () => {
      // Both INSERT and UPDATE return 0 rows on every attempt.
      setupLockMocks({ insertedRows: 0, updatedRows: 0 });

      const manager = new NonceManager({
        maxLockRetries: 3,
        lockRetryDelayMs: 1,
      });
      const provider = createMockProvider();

      await expect(
        manager.startSession(
          "0x1234567890123456789012345678901234567890",
          1,
          "exec_123",
          provider as unknown as import("ethers").Provider
        )
      ).rejects.toThrow(FAILED_LOCK_REGEX);

      // Saturation is the author's configuration, so it counts a metric
      // without paging.
      expect(mockLogUserError).toHaveBeenCalledWith(
        "configuration",
        expect.stringContaining("acquire_failed"),
        expect.any(Error),
        expect.objectContaining({
          wallet_address: "0x1234567890123456789012345678901234567890",
          chain_id: "1",
          execution_id: "exec_123",
        })
      );
      expect(mockLogSystemError).not.toHaveBeenCalled();
    });

    it("warns when taking over an expired lock from a prior holder", async () => {
      // INSERT returns 0 rows, SELECT returns a stale prior holder, UPDATE
      // takes it over.
      mockInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      });
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ walletAddress: "0x" }]),
          }),
        }),
      });
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                lockedBy: "exec_wedged",
                expiresAt: new Date(Date.now() - 30_000),
              },
            ]),
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = createMockProvider();

      await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_takeover",
        provider as unknown as import("ethers").Provider
      );

      // Lock takeover is a system-level smoke signal: logSystemWarn(message).
      const takeoverLogged = mockLogSystemWarn.mock.calls.some((call) =>
        String(call[1] ?? "").includes("Lock takeover")
      );
      expect(takeoverLogged).toBe(true);
    });
  });

  describe("getNextNonce", () => {
    it("returns current nonce and increments", () => {
      const manager = new NonceManager();
      const session: NonceSession = {
        walletAddress: "0x1234",
        chainId: 1,
        executionId: "exec_123",
        currentNonce: 5,
        startedAt: new Date(),
      };

      expect(manager.getNextNonce(session)).toBe(5);
      expect(session.currentNonce).toBe(6);
      expect(manager.getNextNonce(session)).toBe(6);
      expect(session.currentNonce).toBe(7);
    });
  });

  describe("recordTransaction", () => {
    it("calls insert with onConflictDoUpdate", async () => {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ walletAddress: "0x" }]),
          }),
          onConflictDoUpdate,
        }),
      });

      const manager = new NonceManager();
      const session: NonceSession = {
        walletAddress: "0x1234",
        chainId: 1,
        executionId: "exec_123",
        currentNonce: 5,
        startedAt: new Date(),
      };

      await manager.recordTransaction(
        session,
        5,
        "0xtxhash123",
        "wf_456",
        "1000000000"
      );

      expect(onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe("confirmTransaction", () => {
    it("updates transaction status to confirmed", async () => {
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockUpdate.mockReturnValue({ set });

      const manager = new NonceManager();
      await manager.confirmTransaction("0xtxhash123");

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "confirmed" })
      );
    });
  });

  describe("endSession", () => {
    it("releases the lock for the session's holder", async () => {
      const manager = new NonceManager();
      const provider = createMockProvider();

      const { session } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      vi.clearAllMocks();
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await manager.endSession(session);

      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("validation and reconciliation", () => {
    it("reconciles confirmed transactions", async () => {
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: "0x1234567890123456789012345678901234567890",
                chainId: 1,
                nonce: 4,
                txHash: "0xconfirmed",
                status: "pending",
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = createMockProvider({
        transactionCount: 5,
        transactionReceipt: { blockNumber: 123 },
      });

      const { validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      expect(validation.reconciledCount).toBe(1);
    });

    it("detects replaced transactions", async () => {
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: "0x1234567890123456789012345678901234567890",
                chainId: 1,
                nonce: 4,
                txHash: "0xreplaced",
                status: "pending",
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = {
        getTransactionCount: vi.fn().mockResolvedValue(5),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue(null),
      };

      const { validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      expect(provider.getTransactionReceipt).toHaveBeenCalledWith("0xreplaced");
      const hasReplacedWarning = validation.warnings.some((w) =>
        w.includes("replaced or dropped")
      );
      expect(hasReplacedWarning || validation.reconciledCount > 0).toBe(true);
    });

    it("detects dropped mempool transactions", async () => {
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: "0x1234567890123456789012345678901234567890",
                chainId: 1,
                nonce: 5,
                txHash: "0xdropped",
                status: "pending",
                submittedAt: new Date(),
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = {
        getTransactionCount: vi.fn().mockResolvedValue(5),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue(null),
      };

      const { validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_123",
        provider as unknown as import("ethers").Provider
      );

      expect(provider.getTransaction).toHaveBeenCalledWith("0xdropped");
      const hasDroppedWarning = validation.warnings.some((w) =>
        w.includes("dropped from mempool")
      );
      const hasStillPendingWarning = validation.warnings.some((w) =>
        w.includes("still pending in mempool")
      );
      expect(
        hasDroppedWarning ||
          hasStillPendingWarning ||
          validation.reconciledCount > 0
      ).toBe(true);
    });

    it("marks future-nonce row dropped when not in mempool (KEEP-348)", async () => {
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: "0x1234567890123456789012345678901234567890",
                chainId: 1,
                nonce: 3,
                txHash: "0xfuturedropped",
                status: "pending",
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = {
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue(null),
      };

      const { validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_future_dropped",
        provider as unknown as import("ethers").Provider
      );

      expect(provider.getTransaction).toHaveBeenCalledWith("0xfuturedropped");
      expect(mockUpdate).toHaveBeenCalled();
      expect(validation.reconciledCount).toBe(1);
      const hasDroppedWarning = validation.warnings.some((w) =>
        w.includes("not in mempool, marked dropped")
      );
      expect(hasDroppedWarning).toBe(true);
    });

    it("keeps future-nonce row pending when still in mempool (KEEP-348)", async () => {
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: "0x1234567890123456789012345678901234567890",
                chainId: 1,
                nonce: 3,
                txHash: "0xfuturequeued",
                status: "pending",
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const manager = new NonceManager();
      const provider = {
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue({ hash: "0xfuturequeued" }),
      };

      const { validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_future_queued",
        provider as unknown as import("ethers").Provider
      );

      expect(provider.getTransaction).toHaveBeenCalledWith("0xfuturequeued");
      expect(validation.reconciledCount).toBe(0);
      const hasQueuedWarning = validation.warnings.some((w) =>
        w.includes("queued behind predecessors")
      );
      expect(hasQueuedWarning).toBe(true);
    });
  });

  describe("DB-aware nonce selection", () => {
    it("advances starting nonce past DB pending transactions", async () => {
      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount += 1;
        // After KEEP-348 reorder: validateAndReconcile runs first (calls 1 + 2),
        // then the maxNonce query (call 3).
        if (selectCallCount === 3) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ maxNonce: 7 }]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
      });

      const manager = new NonceManager();
      const provider = createMockProvider({ transactionCount: 5 });

      const { session } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_db_aware",
        provider as unknown as import("ethers").Provider
      );

      expect(session.currentNonce).toBe(8);
    });

    it("uses chain nonce when no DB pending rows exist", async () => {
      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount += 1;
        if (selectCallCount === 3) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ maxNonce: null }]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
      });

      const manager = new NonceManager();
      const provider = createMockProvider({ transactionCount: 10 });

      const { session } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        1,
        "exec_no_pending",
        provider as unknown as import("ethers").Provider
      );

      expect(session.currentNonce).toBe(10);
    });

    it("recovers from future-nonce phantom rows after reconcile (KEEP-348)", async () => {
      // Reproduces issue #985: chainNonce=0, DB has phantom pending nonces 1-4.
      // After reconcile (mempool returns null for all), max(pending) returns
      // null and safeNonce collapses back to chainNonce=0.
      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount += 1;
        if (selectCallCount === 1) {
          // validateAndReconcile pending-rows fetch
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue(
                  [1, 2, 3, 4].map((n) => ({
                    walletAddress: "0x1234567890123456789012345678901234567890",
                    chainId: 8453,
                    nonce: n,
                    txHash: `0xphantom${n}`,
                    status: "pending",
                  }))
                ),
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (selectCallCount === 3) {
          // maxNonce query, AFTER reconcile would have dropped all phantoms
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ maxNonce: null }]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
      });

      const manager = new NonceManager();
      const provider = {
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue(null),
      };

      const { session, validation } = await manager.startSession(
        "0x1234567890123456789012345678901234567890",
        8453,
        "exec_recover",
        provider as unknown as import("ethers").Provider
      );

      expect(session.currentNonce).toBe(0);
      expect(validation.reconciledCount).toBe(4);
      expect(provider.getTransaction).toHaveBeenCalledTimes(4);
    });
  });

  describe("lock heartbeat", () => {
    const WALLET = "0x1234567890123456789012345678901234567890";
    const TTL_MS = 4000;
    const BEAT_MS = TTL_MS / 4;

    // Replace the default UPDATE chain with one whose spies can be inspected.
    // `updatedRows` is what the fenced heartbeat UPDATE returns: 1 = still the
    // holder, 0 = the fence no longer matches.
    function mockLockUpdate(updatedRows: number) {
      const returning = vi
        .fn()
        .mockResolvedValue(updatedRows > 0 ? [{ walletAddress: "0x" }] : []);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      mockUpdate.mockReturnValue({ set });
      return { set, where };
    }

    async function startSessionWithTtl(executionId: string) {
      const manager = new NonceManager({ lockTtlMs: TTL_MS });
      const { session } = await manager.startSession(
        WALLET,
        1,
        executionId,
        createMockProvider() as unknown as import("ethers").Provider
      );
      return { manager, session };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("extends expires_at on the holder's fence every quarter TTL", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_beat");
      const { set, where } = mockLockUpdate(1);

      await vi.advanceTimersByTimeAsync(BEAT_MS);

      expect(set).toHaveBeenCalledTimes(1);
      // The expiry is computed by Postgres when the statement lands, not in JS
      // when it is built, so a beat delayed on a saturated pool still writes a
      // full TTL ahead.
      const { expiresAt } = set.mock.calls[0][0] as { expiresAt: SQL };
      const rendered = new PgDialect().sqlToQuery(expiresAt);
      expect(rendered.sql).toContain("NOW()");
      expect(rendered.params).toEqual([TTL_MS]);
      expect(boundParams(where.mock.calls[0][0])).toEqual([
        "wallet_address",
        WALLET,
        "chain_id",
        1,
        "locked_by",
        "exec_beat",
      ]);
      expect(session.lost).toBe(false);

      await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
      expect(set).toHaveBeenCalledTimes(3);

      await manager.endSession(session);
    });

    it("stops the heartbeat when the session ends", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_end");
      expect(vi.getTimerCount()).toBe(1);

      await manager.endSession(session);
      expect(vi.getTimerCount()).toBe(0);

      const { set } = mockLockUpdate(1);
      await vi.advanceTimersByTimeAsync(TTL_MS * 2);
      expect(set).not.toHaveBeenCalled();
    });

    it("stops the heartbeat when setup fails after the lock is acquired", async () => {
      vi.useFakeTimers();
      const manager = new NonceManager({ lockTtlMs: TTL_MS });
      const provider = createMockProvider();
      provider.getTransactionCount.mockRejectedValue(new Error("RPC error"));

      await expect(
        manager.startSession(
          WALLET,
          1,
          "exec_setup_fail",
          provider as unknown as import("ethers").Provider
        )
      ).rejects.toThrow("RPC error");

      expect(vi.getTimerCount()).toBe(0);
    });

    it("marks the session lost and warns once when the fence no longer matches", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_loser");
      const { set } = mockLockUpdate(0);

      await vi.advanceTimersByTimeAsync(BEAT_MS);

      expect(session.lost).toBe(true);
      expect(mockLogSystemWarn).toHaveBeenCalledTimes(1);
      expect(mockLogSystemWarn).toHaveBeenCalledWith(
        "infrastructure",
        expect.stringContaining("Lock lost"),
        expect.any(Error),
        expect.objectContaining({
          wallet_address: WALLET,
          chain_id: "1",
          execution_id: "exec_loser",
        })
      );
      // The heartbeat stops itself: no further extensions, no repeat logs.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
      expect(set).toHaveBeenCalledTimes(1);
      expect(mockLogSystemWarn).toHaveBeenCalledTimes(1);

      await manager.endSession(session);
    });

    it("keeps beating when an extension errors rather than declaring the lock lost", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_db_blip");
      const returning = vi.fn().mockRejectedValue(new Error("db down"));
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning }),
        }),
      });

      await vi.advanceTimersByTimeAsync(BEAT_MS);

      expect(session.lost).toBe(false);
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("heartbeat failed"),
        expect.objectContaining({
          execution_id: "exec_db_blip",
          error: "db down",
        })
      );
      expect(mockLogSystemWarn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await manager.endSession(session);
    });

    it("refuses to hand out another nonce once the session is lost", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_no_nonce");
      mockLockUpdate(0);

      // One nonce before the loss, none after.
      expect(manager.getNextNonce(session)).toBe(5);
      await vi.advanceTimersByTimeAsync(BEAT_MS);

      expect(session.lost).toBe(true);
      expect(() => manager.getNextNonce(session)).toThrow(NonceLockLostError);

      await manager.endSession(session);
    });

    it("does not start a beat while the previous one is still in flight", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_slow_db");

      let landFirstBeat: (() => void) | undefined;
      const returning = vi.fn(
        () =>
          new Promise((resolve) => {
            landFirstBeat = () => resolve([{ walletAddress: "0x" }]);
          })
      );
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning }),
        }),
      });

      // Three beats fall due while the first is still waiting on the pool.
      await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
      expect(returning).toHaveBeenCalledTimes(1);

      landFirstBeat?.();
      await vi.advanceTimersByTimeAsync(BEAT_MS);
      expect(returning).toHaveBeenCalledTimes(2);

      await manager.endSession(session);
    });

    it("stops beating and marks the session lost after the maximum lifetime", async () => {
      vi.useFakeTimers();
      const { manager, session } = await startSessionWithTtl("exec_forever");
      const { set } = mockLockUpdate(1);

      // MAX_SESSION_TTLS is 5, so the beat due at 5 x TTL gives up instead of
      // extending: 19 extensions land, the 20th beat stops the heartbeat.
      await vi.advanceTimersByTimeAsync(TTL_MS * 5);

      expect(set).toHaveBeenCalledTimes(19);
      expect(session.lost).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(mockLogSystemWarn).toHaveBeenCalledWith(
        "infrastructure",
        expect.stringContaining("Session lifetime exceeded"),
        expect.any(Error),
        expect.objectContaining({ execution_id: "exec_forever" })
      );
      expect(() => manager.getNextNonce(session)).toThrow(NonceLockLostError);

      await manager.endSession(session);
    });

    it("unrefs the heartbeat timer so it cannot keep the process alive", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const manager = new NonceManager();
      const { session } = await manager.startSession(
        WALLET,
        1,
        "exec_unref",
        createMockProvider() as unknown as import("ethers").Provider
      );

      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);

      await manager.endSession(session);
      setIntervalSpy.mockRestore();
    });
  });

  describe("session reads through the RPC manager", () => {
    it("routes the chain reads through executeWithFailover as reads", async () => {
      const wallet = "0x1234567890123456789012345678901234567890";
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: wallet,
                chainId: 1,
                nonce: 4,
                txHash: "0xmined",
                status: "pending",
              },
              {
                walletAddress: wallet,
                chainId: 1,
                nonce: 5,
                txHash: "0xinflight",
                status: "pending",
                submittedAt: new Date(),
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      const provider = createMockProvider({
        transactionCount: 5,
        transactionReceipt: { blockNumber: 123 },
        transaction: { hash: "0xinflight" },
      });
      const executeWithFailover = vi.fn(
        (operation: (p: unknown) => Promise<unknown>, _operationType: string) =>
          operation(provider)
      );
      const rpcManager = {
        executeWithFailover,
      } as unknown as RpcProviderManager;

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        wallet,
        1,
        "exec_failover",
        rpcManager
      );

      expect(executeWithFailover.mock.calls.map((call) => call[1])).toEqual([
        "read",
        "read",
        "read",
      ]);
      expect(provider.getTransactionCount).toHaveBeenCalledWith(
        wallet,
        "pending"
      );
      expect(provider.getTransactionReceipt).toHaveBeenCalledWith("0xmined");
      expect(provider.getTransaction).toHaveBeenCalledWith("0xinflight");
      expect(validation.chainNonce).toBe(5);
      expect(validation.reconciledCount).toBe(1);

      await manager.endSession(session);
    });

    it("does not mark a tx dropped when a different endpoint answered the mempool read", async () => {
      const wallet = "0x1234567890123456789012345678901234567890";
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: wallet,
                chainId: 1,
                nonce: 5,
                txHash: "0xinflight",
                status: "pending",
                submittedAt: new Date(),
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // The primary answers getTransactionCount; the fallback answers the
      // mempool read and has never seen 0xinflight.
      const primary = createMockProvider({ transactionCount: 5 });
      const fallback = createMockProvider({ transaction: null });
      let served = 0;
      const executeWithFailover = vi.fn(
        (operation: (p: unknown) => Promise<unknown>) => {
          served += 1;
          return operation(served === 1 ? primary : fallback);
        }
      );
      const rpcManager = {
        executeWithFailover,
      } as unknown as RpcProviderManager;

      // Any update at this point would be a reconciliation write; the lock was
      // acquired on the INSERT.
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockUpdate.mockReturnValue({ set });

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        wallet,
        1,
        "exec_split_view",
        rpcManager
      );

      expect(fallback.getTransaction).toHaveBeenCalledWith("0xinflight");
      expect(set).not.toHaveBeenCalled();
      expect(validation.reconciledCount).toBe(0);
      expect(validation.warnings.join("; ")).toContain(
        "different RPC endpoint answered"
      );

      await manager.endSession(session);
    });

    it("still marks a tx dropped when the same endpoint answered both reads", async () => {
      const wallet = "0x1234567890123456789012345678901234567890";
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                walletAddress: wallet,
                chainId: 1,
                nonce: 5,
                txHash: "0xgone",
                status: "pending",
                submittedAt: new Date(),
              },
            ]),
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const primary = createMockProvider({
        transactionCount: 5,
        transaction: null,
      });
      const rpcManager = {
        executeWithFailover: vi.fn(
          (operation: (p: unknown) => Promise<unknown>) => operation(primary)
        ),
      } as unknown as RpcProviderManager;

      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockUpdate.mockReturnValue({ set });

      const manager = new NonceManager();
      const { session, validation } = await manager.startSession(
        wallet,
        1,
        "exec_single_view",
        rpcManager
      );

      expect(set).toHaveBeenCalledWith({ status: "dropped" });
      expect(validation.reconciledCount).toBe(1);

      await manager.endSession(session);
    });
  });

  describe("singleton pattern", () => {
    it("returns same instance from getNonceManager", () => {
      const manager1 = getNonceManager();
      const manager2 = getNonceManager();
      expect(manager1).toBe(manager2);
    });

    it("returns new instance after reset", () => {
      const manager1 = getNonceManager();
      resetNonceManager();
      const manager2 = getNonceManager();
      expect(manager1).not.toBe(manager2);
    });
  });
});
