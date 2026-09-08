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
const mockQuoteTempoSwap = vi.fn();
const mockBuildTempoTxLink = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  assertTempoChain: (...args: unknown[]) => mockAssertTempoChain(...args),
  resolveTempoToken: (...args: unknown[]) => mockResolveTempoToken(...args),
  quoteTempoSwap: (...args: unknown[]) => mockQuoteTempoSwap(...args),
  buildTempoTxLink: (...args: unknown[]) => mockBuildTempoTxLink(...args),
}));

const mockSignAndBroadcast = vi.fn();
const mockBuildSwapCall = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  signAndBroadcastTempoTx: (...args: unknown[]) =>
    mockSignAndBroadcast(...args),
  buildSwapExactAmountInCall: (...args: unknown[]) =>
    mockBuildSwapCall(...args),
}));

import { type DexSwapInput, dexSwapStep } from "@/plugins/tempo/steps/dex-swap";

const USDC = "0x20c0000000000000000000000000000000000001";
const ALPHA = "0x20c0000000000000000000000000000000000002";

function baseInput(overrides: Partial<DexSwapInput> = {}): DexSwapInput {
  return {
    network: "tempo-testnet",
    tokenInConfig: { supportedTokenId: "usdc" },
    tokenOutConfig: { supportedTokenId: "alpha" },
    amountIn: "100",
    _context: { organizationId: "org1", executionId: "exec1" },
    ...overrides,
  } as DexSwapInput;
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
  mockResolveTempoToken.mockImplementation(
    (config: { supportedTokenId?: string }) =>
      config?.supportedTokenId === "usdc"
        ? Promise.resolve({ address: USDC, decimals: 6, symbol: "USDC" })
        : Promise.resolve({ address: ALPHA, decimals: 6, symbol: "AlphaUSD" })
  );
  mockQuoteTempoSwap.mockResolvedValue(BigInt(99_000_000)); // 99 out
  mockBuildSwapCall.mockReturnValue({ to: "0xdec0", data: "0xswap" });
  mockSignAndBroadcast.mockResolvedValue({ hash: "0xhash", from: "0xFROM" });
  mockBuildTempoTxLink.mockResolvedValue("https://explorer/tx/0xhash");
});

describe("dexSwapStep", () => {
  it("quotes, applies the slippage floor, and swaps", async () => {
    const res = await dexSwapStep(baseInput());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.transactionHash).toBe("0xhash");
      expect(res.tokenIn).toBe("USDC");
      expect(res.tokenOut).toBe("AlphaUSD");
      expect(res.quotedOut).toBe("99.0");
      // 99 * (1 - 0.005) = 98.505
      expect(res.minAmountOut).toBe("98.505");
    }
    // 100 in (6 decimals), minAmountOut = 99e6 * 9950 / 10000
    expect(mockBuildSwapCall).toHaveBeenCalledWith(
      USDC,
      ALPHA,
      BigInt(100_000_000),
      BigInt(98_505_000)
    );
    expect(mockSignAndBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ feeToken: USDC, chainId: 42_431 })
    );
  });

  it("rejects swapping a token for itself", async () => {
    const res = await dexSwapStep(
      baseInput({ tokenOutConfig: { supportedTokenId: "usdc" } })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("must be different");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range slippage", async () => {
    const res = await dexSwapStep(baseInput({ slippageBps: 10_000 }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Slippage");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("rejects when the pair has no liquidity", async () => {
    mockQuoteTempoSwap.mockResolvedValue(BigInt(0));
    const res = await dexSwapStep(baseInput());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("No DEX liquidity");
    }
    expect(mockSignAndBroadcast).not.toHaveBeenCalled();
  });

  it("requires an amount", async () => {
    const res = await dexSwapStep(baseInput({ amountIn: "" }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Amount is required");
    }
  });

  it("surfaces a swap failure as a step error", async () => {
    mockSignAndBroadcast.mockRejectedValue(new Error("swap reverted"));
    const res = await dexSwapStep(baseInput());
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("reverted");
    }
  });
});
