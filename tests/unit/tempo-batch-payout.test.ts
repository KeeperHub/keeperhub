import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));
vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

const mockGetChainIdFromNetwork = vi.fn();
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

const mockGetRpcProvider = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

const mockResolveOrganizationContext = vi.fn();
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: (...args: unknown[]) =>
    mockResolveOrganizationContext(...args),
}));

const mockAssertTempoChain = vi.fn();
const mockResolveTempoToken = vi.fn();
const mockBuildTempoTxLink = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  assertTempoChain: (...args: unknown[]) => mockAssertTempoChain(...args),
  resolveTempoToken: (...args: unknown[]) => mockResolveTempoToken(...args),
  buildTempoTxLink: (...args: unknown[]) => mockBuildTempoTxLink(...args),
}));

const mockSignAndBroadcast = vi.fn();
const mockNormalizeMemo = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  signAndBroadcastTempoTx: (...args: unknown[]) =>
    mockSignAndBroadcast(...args),
  buildTransferWithMemoCall: (token: string) => ({ to: token, data: "0xdata" }),
  normalizeMemo: (...args: unknown[]) => mockNormalizeMemo(...args),
}));

import {
  type BatchPayoutInput,
  batchPayoutStep,
} from "@/plugins/tempo/steps/batch-payout";

const USDC = "0x20c0000000000000000000000000000000000001";
const RECIPIENT_A = "0x1111111111111111111111111111111111111111";
const RECIPIENT_B = "0x2222222222222222222222222222222222222222";

function baseInput(
  overrides: Partial<BatchPayoutInput> = {}
): BatchPayoutInput {
  return {
    network: "tempo-testnet",
    tokenConfig: { supportedTokenId: "tok_usdc" },
    payouts: JSON.stringify([
      { recipient: RECIPIENT_A, amount: "10" },
      { recipient: RECIPIENT_B, amount: "20", memo: "INV-2" },
    ]),
    memo: "PAYRUN-2026-07",
    _context: { organizationId: "org1", executionId: "exec1" },
    ...overrides,
  } as BatchPayoutInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChainIdFromNetwork.mockReturnValue(42_431);
  mockAssertTempoChain.mockReturnValue(undefined);
  mockResolveOrganizationContext.mockResolvedValue({
    success: true,
    organizationId: "org1",
    userId: "u1",
  });
  mockGetRpcProvider.mockResolvedValue({});
  mockResolveTempoToken.mockResolvedValue({
    address: USDC,
    decimals: 6,
    symbol: "USDC",
  });
  mockNormalizeMemo.mockReturnValue("0xMEMO");
  mockSignAndBroadcast.mockResolvedValue({ hash: "0xhash", from: "0xFROM" });
  mockBuildTempoTxLink.mockResolvedValue("https://explorer/tx/0xhash");
});

describe("batchPayoutStep", () => {
  it("batches every payout into one atomic transaction", async () => {
    const res = await batchPayoutStep(baseInput());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.transactionHash).toBe("0xhash");
      expect(res.payoutCount).toBe(2);
      expect(res.totalAmount).toBe("30.0");
      expect(res.chainId).toBe(42_431);
    }
    const args = mockSignAndBroadcast.mock.calls[0][0];
    expect(args.calls).toHaveLength(2);
    expect(args.feeToken).toBe(USDC);
    expect(args.chainId).toBe(42_431);
  });

  it("falls back to the shared memo when a payout omits one", async () => {
    await batchPayoutStep(baseInput());
    // First payout has no memo -> shared; second sets its own.
    expect(mockNormalizeMemo).toHaveBeenNthCalledWith(1, "PAYRUN-2026-07");
    expect(mockNormalizeMemo).toHaveBeenNthCalledWith(2, "INV-2");
  });

  it("rejects an empty payout list", async () => {
    const res = await batchPayoutStep(baseInput({ payouts: "[]" }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("empty");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a batch over the per-transaction limit", async () => {
    const many = JSON.stringify(
      Array.from({ length: 51 }, () => ({
        recipient: RECIPIENT_A,
        amount: "1",
      }))
    );
    const res = await batchPayoutStep(baseInput({ payouts: many }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Too many payouts");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient in any entry", async () => {
    const res = await batchPayoutStep(
      baseInput({
        payouts: JSON.stringify([{ recipient: "nope", amount: "10" }]),
      })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("invalid recipient");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("surfaces a broadcast failure as a step error", async () => {
    mockSignAndBroadcast.mockRejectedValue(
      new Error("Tempo transaction reverted (0xabc)")
    );
    const res = await batchPayoutStep(baseInput());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("reverted");
    }
  });
});
