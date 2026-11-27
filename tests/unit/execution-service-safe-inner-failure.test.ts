import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const verifyExecutionReceipts = vi.fn();
  const selectLimit = vi.fn();
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: selectLimit }) }),
  }));
  return { where, set, update, select, selectLimit, verifyExecutionReceipts };
});

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/db", () => ({
  db: { update: mocks.update, select: mocks.select },
}));
vi.mock("@/lib/db/schema", () => ({
  directExecutions: {
    id: { name: "id" },
    organizationId: { name: "organization_id" },
  },
}));
vi.mock("@/lib/utils/id", () => ({ generateId: vi.fn(() => "exec_test") }));
vi.mock("@/lib/web3/verify-receipt", () => ({
  verifyExecutionReceipts: (...args: unknown[]) =>
    mocks.verifyExecutionReceipts(...args),
  hasUnreadableReceipt: vi.fn(() => false),
  describeVerificationFailure: vi.fn(() => "verification failed"),
}));

import {
  completeExecution,
  failExecution,
} from "@/app/api/execute/_lib/execution-service";
import { orgScope } from "@/lib/rpc/engine/scope";

const ORG_SCOPE = orgScope("org_1");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectLimit.mockResolvedValue([{ organizationId: "org_1" }]);
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
  it("keeps a hash without chain context unconfirmed", async () => {
    const outcome = await failExecution("exec_1", "chain context missing", {
      transactionHash: "0xunknown",
    });

    expect(outcome).toEqual({ status: "unconfirmed" });
    expect(mocks.verifyExecutionReceipts).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unconfirmed", completedAt: null })
    );
  });

  it("keeps safe_inner_failure unconfirmed because the outer Safe transaction consumed its nonce", async () => {
    const outcome = await failExecution("exec_1", "inner call reverted", {
      transactionHash: "0xsafe",
      chainId: 8453,
    });

    expect(outcome).toEqual({ status: "unconfirmed" });
    expect(mocks.verifyExecutionReceipts).toHaveBeenCalledWith(
      [{ hash: "0xsafe", chainId: 8453 }],
      ORG_SCOPE
    );
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

describe("completeExecution Safe receipt handling", () => {
  it("keeps safe_inner_failure unconfirmed in the !allVerified branch, mirroring failExecution", async () => {
    // The verify mock returns a safe_inner_failure receipt and no allVerified
    // flag (falsy), so completeExecution takes its !allVerified branch.
    // Without the hoisted guard this settled `failed`, which maps to
    // `release` in idempotency-disposition and frees the key for a retry
    // that spends a second Safe nonce and a second signature set.
    const outcome = await completeExecution("exec_2", {
      transactionHash: "0xsafe",
      chainId: 8453,
    });

    expect(outcome.status).toBe("unconfirmed");
    expect(mocks.verifyExecutionReceipts).toHaveBeenCalledWith(
      [{ hash: "0xsafe", chainId: 8453 }],
      ORG_SCOPE
    );
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unconfirmed",
        completedAt: null,
      })
    );
  });
});
