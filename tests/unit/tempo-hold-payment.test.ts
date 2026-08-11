import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

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
const UNIX_RE = /^\d+$/;
vi.mock("@/plugins/tempo/steps/tempo-step-helpers", () => ({
  assertTempoChain: (...args: unknown[]) => mockAssertTempoChain(...args),
  resolveTempoToken: (...args: unknown[]) => mockResolveTempoToken(...args),
  buildTempoTxLink: vi.fn(),
  // Faithful inline copy so the window logic gets real parsing.
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

const mockSignTempoTx = vi.fn();
const mockBuildCall = vi.fn();
const mockNormalizeMemo = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  signTempoTx: (...args: unknown[]) => mockSignTempoTx(...args),
  buildTransferWithMemoCall: (...args: unknown[]) => mockBuildCall(...args),
  normalizeMemo: (...args: unknown[]) => mockNormalizeMemo(...args),
}));

const mockCreateHeldPayment = vi.fn();
vi.mock("@/lib/tempo/held-payments", () => ({
  createHeldPayment: (...args: unknown[]) => mockCreateHeldPayment(...args),
}));

import {
  type HoldPaymentInput,
  holdPaymentStep,
} from "@/plugins/tempo/steps/hold-payment";
import { executeHoldPayment } from "@/plugins/tempo/steps/hold-payment-core";

const USDC = "0x20c0000000000000000000000000000000000001";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW_SEC = 1_800_000_000;
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

function baseInput(
  overrides: Partial<HoldPaymentInput> = {}
): HoldPaymentInput {
  return {
    network: "tempo-testnet",
    tokenConfig: { supportedTokenId: "usdc" },
    amount: "500",
    recipientAddress: RECIPIENT,
    memo: "INV-1",
    _context: {
      organizationId: "org1",
      executionId: "exec1",
      workflowId: "wf1",
    },
    ...overrides,
  } as HoldPaymentInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
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
  mockSignTempoTx.mockImplementation((p: { validBefore?: number }) =>
    Promise.resolve({
      serialized: "0x76blob",
      hash: "0xhash",
      from: "0xFROM",
      chainId: 42_431,
      nonceKey: BigInt(123),
      nonce: BigInt(5),
      maxFeePerGas: BigInt(2000),
      validAfter: undefined,
      validBefore: p.validBefore,
    })
  );
  mockCreateHeldPayment.mockImplementation((a: Record<string, unknown>) =>
    Promise.resolve({ id: "held-1", ...a })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("holdPaymentStep - manual mode", () => {
  it("signs and holds with a 24h default window and no broadcast target", async () => {
    const res = await holdPaymentStep(baseInput());

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.paymentId).toBe("held-1");
      expect(res.broadcastMode).toBe("manual");
      expect(res.broadcastAt).toBeNull();
      expect(res.validBefore).toBe(NOW_SEC + DAY);
      expect(res.status).toBe("pending");
      expect(res.precomputedHash).toBe("0xhash");
    }

    const signArgs = mockSignTempoTx.mock.calls[0][0];
    expect(signArgs.validBefore).toBe(NOW_SEC + DAY);
    expect(signArgs.maxFeePerGasMultiplier).toBe(4);
    expect(signArgs.maxFeePerGasFloor).toBe(BigInt(50_000_000_000));

    const createArgs = mockCreateHeldPayment.mock.calls[0][0];
    expect(createArgs.broadcastAt).toBeNull();
    expect(createArgs.serializedTx).toBe("0x76blob");
    expect(createArgs.precomputedHash).toBe("0xhash");
    expect(createArgs.nonceKey).toBe("123");
    expect(createArgs.maxFeePerGas).toBe("2000");
    expect(createArgs.workflowId).toBe("wf1");
  });

  it("honors an explicit validBefore", async () => {
    const res = await holdPaymentStep(
      baseInput({ validBefore: String(NOW_SEC + 3 * HOUR) })
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.validBefore).toBe(NOW_SEC + 3 * HOUR);
    }
  });

  it("rejects a window that closes inside the 60s buffer", async () => {
    const res = await holdPaymentStep(
      baseInput({ validBefore: String(NOW_SEC + 10) })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("too soon");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
    expect(mockCreateHeldPayment).not.toHaveBeenCalled();
  });
});

describe("holdPaymentStep - schedule mode", () => {
  it("holds with a future broadcast target and a defaulted window", async () => {
    const res = await holdPaymentStep(
      baseInput({
        broadcastMode: "schedule",
        broadcastAt: String(NOW_SEC + 2 * HOUR),
      })
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.broadcastMode).toBe("schedule");
      expect(res.broadcastAt).toBe(
        new Date((NOW_SEC + 2 * HOUR) * 1000).toISOString()
      );
      expect(res.validBefore).toBe(NOW_SEC + 2 * HOUR + HOUR);
    }
    const createArgs = mockCreateHeldPayment.mock.calls[0][0];
    expect(createArgs.broadcastAt).toBeInstanceOf(Date);
    expect((createArgs.broadcastAt as Date).getTime()).toBe(
      (NOW_SEC + 2 * HOUR) * 1000
    );
  });

  it("requires broadcastAt", async () => {
    const res = await holdPaymentStep(baseInput({ broadcastMode: "schedule" }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("broadcastAt is required");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });

  it("rejects a broadcastAt in the past", async () => {
    const res = await holdPaymentStep(
      baseInput({
        broadcastMode: "schedule",
        broadcastAt: String(NOW_SEC - 60),
      })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("must be in the future");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });

  it("rejects a validBefore that is not after the broadcast time", async () => {
    const res = await holdPaymentStep(
      baseInput({
        broadcastMode: "schedule",
        broadcastAt: String(NOW_SEC + 2 * HOUR),
        validBefore: String(NOW_SEC + HOUR),
      })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("validBefore must be after");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });
});

describe("holdPaymentStep - input validation", () => {
  it("rejects an invalid recipient", async () => {
    const res = await holdPaymentStep(baseInput({ recipientAddress: "nope" }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Invalid recipient");
    }
  });

  it("rejects a missing amount", async () => {
    const res = await holdPaymentStep(baseInput({ amount: "" }));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Amount is required");
    }
  });

  it("rejects an invalid recipient before requiring execution context", async () => {
    const res = await holdPaymentStep(
      baseInput({
        recipientAddress: "nope",
        _context: undefined,
      })
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Invalid recipient");
      expect(res.failureKind).toBe("validation");
    }
    expect(mockResolveOrganizationContext).not.toHaveBeenCalled();
  });
});

describe("executeHoldPayment - validation vs infrastructure", () => {
  it("returns validation failureKind for an unknown token config", async () => {
    mockResolveTempoToken.mockRejectedValue(
      new Error("Unknown token NOTATOKEN")
    );

    const res = await executeHoldPayment({
      organizationId: "org1",
      userId: "u1",
      network: "tempo-testnet",
      tokenConfig: "NOTATOKEN",
      amount: "1",
      recipientAddress: RECIPIENT,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failureKind).toBe("validation");
      expect(res.error).toContain("NOTATOKEN");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });

  it("returns validation failureKind for a non-numeric amount", async () => {
    const res = await executeHoldPayment({
      organizationId: "org1",
      userId: "u1",
      network: "tempo-testnet",
      tokenConfig: { supportedTokenId: "usdc" },
      amount: "abc",
      recipientAddress: RECIPIENT,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failureKind).toBe("validation");
    }
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });

  it("returns infrastructure failureKind when RPC provider setup fails", async () => {
    mockGetRpcProvider.mockRejectedValue(new Error("RPC unavailable"));

    const res = await executeHoldPayment({
      organizationId: "org1",
      userId: "u1",
      network: "tempo-testnet",
      tokenConfig: { supportedTokenId: "usdc" },
      amount: "1",
      recipientAddress: RECIPIENT,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failureKind).toBe("infrastructure");
      expect(res.error).toContain("RPC unavailable");
    }
    expect(mockResolveTempoToken).not.toHaveBeenCalled();
    expect(mockSignTempoTx).not.toHaveBeenCalled();
  });

  it("returns infrastructure failureKind when signing fails", async () => {
    mockSignTempoTx.mockRejectedValue(new Error("Turnkey unavailable"));

    const res = await executeHoldPayment({
      organizationId: "org1",
      userId: "u1",
      network: "tempo-testnet",
      tokenConfig: { supportedTokenId: "usdc" },
      amount: "1",
      recipientAddress: RECIPIENT,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failureKind).toBe("infrastructure");
      expect(res.error).toContain("Turnkey unavailable");
    }
  });
});
