import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  getNonceManager,
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
