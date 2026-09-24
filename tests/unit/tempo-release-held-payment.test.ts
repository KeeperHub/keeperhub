import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const broker = {
  getHeldPaymentForOrg: vi.fn(),
  claimHeldPayment: vi.fn(),
  markBroadcast: vi.fn(),
  markConfirmed: vi.fn(),
  markFailed: vi.fn(),
};

vi.mock("@/lib/tempo/held-payments", () => ({
  getHeldPaymentForOrg: (...args: unknown[]) =>
    broker.getHeldPaymentForOrg(...args),
  claimHeldPayment: (...args: unknown[]) => broker.claimHeldPayment(...args),
  markBroadcast: (...args: unknown[]) => broker.markBroadcast(...args),
  markConfirmed: (...args: unknown[]) => broker.markConfirmed(...args),
  markFailed: (...args: unknown[]) => broker.markFailed(...args),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const mockBroadcast = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  broadcastStoredTempoTx: (...args: unknown[]) => mockBroadcast(...args),
}));

import { releaseHeldPaymentNow } from "@/lib/tempo/release-held-payment";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    organizationId: "org-1",
    status: "pending",
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    chainId: 42_431,
    serializedTx: "0xserialized",
    precomputedHash: "0xexpected",
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: "0x2222222222222222222222222222222222222222",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  broker.getHeldPaymentForOrg.mockResolvedValue(row());
  broker.claimHeldPayment.mockResolvedValue(row({ status: "broadcasting" }));
  broker.markBroadcast.mockResolvedValue({});
  broker.markConfirmed.mockResolvedValue({});
  broker.markFailed.mockResolvedValue({});
});

describe("releaseHeldPaymentNow broadcast evidence", () => {
  it("keeps a pending broadcast reconcilable instead of marking it failed", async () => {
    mockBroadcast.mockRejectedValue(
      new OnChainPendingError({
        message: "receipt is still pending",
        transactionHash: "0xpending",
      })
    );

    const result = await releaseHeldPaymentNow({
      paymentId: "payment-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(broker.markBroadcast).toHaveBeenCalledWith("payment-1", "0xpending");
    expect(broker.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: "broadcast-pending",
      error: "receipt is still pending",
      status: "broadcast",
      transactionHash: "0xpending",
    });
  });
});
