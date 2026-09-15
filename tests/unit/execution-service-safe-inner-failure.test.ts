import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const verifyExecutionReceipts = vi.fn();
  return { where, set, update, verifyExecutionReceipts };
});

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/db", () => ({ db: { update: mocks.update } }));
vi.mock("@/lib/db/schema", () => ({
  directExecutions: { id: { name: "id" } },
}));
vi.mock("@/lib/utils/id", () => ({ generateId: vi.fn(() => "exec_test") }));
vi.mock("@/lib/web3/verify-receipt", () => ({
  verifyExecutionReceipts: (...args: unknown[]) =>
    mocks.verifyExecutionReceipts(...args),
  hasUnreadableReceipt: vi.fn(() => false),
  describeVerificationFailure: vi.fn(() => "verification failed"),
}));

import { failExecution } from "@/app/api/execute/_lib/execution-service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyExecutionReceipts.mockResolvedValue({
    results: [
      {
        hash: "0xsafe",
        chainId: 8453,
        verified: false,
        status: "safe_inner_failure",
        blockNumber: 123,
        gasUsed: "21000",
        verifiedAt: "2026-09-14T00:00:00.000Z",
      },
    ],
  });
});

describe("failExecution Safe receipt handling", () => {
  it("keeps safe_inner_failure unconfirmed because the outer Safe transaction consumed its nonce", async () => {
    const outcome = await failExecution("exec_1", "inner call reverted", {
      transactionHash: "0xsafe",
      chainId: 8453,
    });

    expect(outcome).toEqual({ status: "unconfirmed" });
    expect(mocks.verifyExecutionReceipts).toHaveBeenCalledWith([
      { hash: "0xsafe", chainId: 8453 },
    ]);
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unconfirmed",
        completedAt: null,
        receipts: [
          expect.objectContaining({
            hash: "0xsafe",
            chainId: 8453,
            verified: false,
            receiptStatus: "safe_inner_failure",
          }),
        ],
      })
    );
  });
});
