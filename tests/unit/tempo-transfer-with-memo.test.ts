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
const UNIX_RE = /^\d+$/;
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  assertTempoChain: (...args: unknown[]) => mockAssertTempoChain(...args),
  resolveTempoToken: (...args: unknown[]) => mockResolveTempoToken(...args),
  buildTempoTxLink: (...args: unknown[]) => mockBuildTempoTxLink(...args),
  parseTimestamp: (raw?: string): number | undefined => {
    if (!raw || raw.trim() === "") {
      return;
    }
    const v = raw.trim();
    if (UNIX_RE.test(v)) {
      const n = Number(v);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid date "${v}"`);
    }
    return Math.floor(ms / 1000);
  },
}));

const mockSignAndBroadcast = vi.fn();
const mockBuildCall = vi.fn();
const mockNormalizeMemo = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  signAndBroadcastTempoTx: (...args: unknown[]) =>
    mockSignAndBroadcast(...args),
  buildTransferWithMemoCall: (...args: unknown[]) => mockBuildCall(...args),
  normalizeMemo: (...args: unknown[]) => mockNormalizeMemo(...args),
}));

import {
  type TransferWithMemoInput,
  transferWithMemoStep,
} from "@/plugins/tempo/steps/transfer-with-memo";

const USDC = "0x20c0000000000000000000000000000000000001";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function baseInput(
  overrides: Partial<TransferWithMemoInput> = {}
): TransferWithMemoInput {
  return {
    network: "tempo-testnet",
    tokenConfig: { supportedTokenId: "tok_usdc" },
    amount: "100.5",
    recipientAddress: RECIPIENT,
    memo: "INV-1042",
    _context: { organizationId: "org1", executionId: "exec1" },
    ...overrides,
  } as TransferWithMemoInput;
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
  mockBuildCall.mockReturnValue({ to: USDC, data: "0xdata" });
  mockSignAndBroadcast.mockResolvedValue({ hash: "0xhash", from: "0xFROM" });
  mockBuildTempoTxLink.mockResolvedValue("https://explorer/tx/0xhash");
});

describe("transferWithMemoStep", () => {
  it("signs and broadcasts a memo transfer on Tempo", async () => {
    const res = await transferWithMemoStep(baseInput());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.transactionHash).toBe("0xhash");
      expect(res.transactionLink).toBe("https://explorer/tx/0xhash");
      expect(res.from).toBe("0xFROM");
      expect(res.to).toBe(RECIPIENT);
      expect(res.amount).toBe("100.5");
      expect(res.memo).toBe("0xMEMO");
      expect(res.chainId).toBe(42_431);
    }
    // 100.5 parsed with 6 decimals.
    expect(mockBuildCall).toHaveBeenCalledWith(
      USDC,
      RECIPIENT,
      BigInt(100_500_000),
      "0xMEMO"
    );
    expect(mockSignAndBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        userId: "u1",
        chainId: 42_431,
        calls: [{ to: USDC, data: "0xdata" }],
        feeToken: USDC,
      })
    );
  });

  it("rejects an invalid recipient address", async () => {
    const res = await transferWithMemoStep(
      baseInput({ recipientAddress: "not-an-address" })
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Invalid recipient");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a non-Tempo network", async () => {
    mockGetChainIdFromNetwork.mockReturnValue(1);
    mockAssertTempoChain.mockImplementation(() => {
      throw new Error("Chain 1 is not a Tempo network");
    });

    const res = await transferWithMemoStep(baseInput({ network: "ethereum" }));

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("not a Tempo network");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("requires an amount", async () => {
    const res = await transferWithMemoStep(baseInput({ amount: "" }));

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Amount is required");
    }
  });

  it("surfaces a broadcast failure as a step error", async () => {
    mockSignAndBroadcast.mockRejectedValue(
      new Error("Tempo transaction reverted (0xabc)")
    );

    const res = await transferWithMemoStep(baseInput());

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("reverted");
    }
  });

  it("passes an optional on-chain expiry (validBefore) to the transaction", async () => {
    const EXPIRY = 4_102_444_800; // year 2100, safely in the future
    const res = await transferWithMemoStep(
      baseInput({ validBefore: String(EXPIRY) })
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.validBefore).toBe(EXPIRY);
    }
    expect(mockSignAndBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ validBefore: EXPIRY })
    );
  });

  it("defaults to no expiry when validBefore is unset", async () => {
    const res = await transferWithMemoStep(baseInput());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.validBefore).toBeNull();
    }
    expect(mockSignAndBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ validBefore: undefined })
    );
  });

  it("rejects an expiry that is too soon", async () => {
    const res = await transferWithMemoStep(
      baseInput({ validBefore: "1700000000" })
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("too soon");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });
});
