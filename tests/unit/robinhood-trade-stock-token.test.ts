import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Only Contract is stubbed. The encoder uses the real AbiCoder, getAddress and
// parseUnits, and mocking those would hide encoding mistakes rather than
// exercise them.
const mockAllowance = vi.fn();
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  class MockContract {
    allowance: (...args: unknown[]) => Promise<unknown>;
    constructor() {
      this.allowance = (...args: unknown[]) => mockAllowance(...args);
    }
  }
  return { ethers: { ...actual.ethers, Contract: MockContract } };
});

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction", VALIDATION: "validation" },
  logUserError: vi.fn(),
}));

const mockChainId = vi.fn(() => 4663);
vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => mockChainId(),
}));

const mockFailover = vi.fn();
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: () =>
    Promise.resolve({
      executeWithFailover: (op: (p: unknown) => unknown) => mockFailover(op),
      getProvider: () => ({ _getConnection: () => ({ url: "https://rpc" }) }),
    }),
}));

const mockResolveToken = vi.fn();
const mockOnChain = vi.fn();
vi.mock("@/plugins/robinhood/steps/stock-token-core", () => ({
  ROBINHOOD_CHAIN_ID: 4663,
  resolveStockToken: (s: string) => mockResolveToken(s),
  readOnChainState: () => mockOnChain(),
}));

const mockResolveForWrite = vi.fn();
vi.mock("@/lib/web3/ui-multiplier", () => ({
  resolveForWrite: () => mockResolveForWrite(),
  convertAmountForWrite: (ui: bigint) => ({ ok: true, raw: ui }),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: () =>
    Promise.resolve({ success: true, organizationId: "org1", userId: "u1" }),
}));

const mockSignerMode = vi.fn(() => ({ kind: "eoa" }));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: () => Promise.resolve(mockSignerMode()),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeWalletSigner: () => Promise.resolve({}),
  getOrganizationWalletAddress: () =>
    Promise.resolve("0x1111111111111111111111111111111111111111"),
}));

const mockGasCheck = vi.fn(() => ({ affordable: true }));
const mockExecute = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({ executeContractCall: () => mockExecute() }),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: (
    _ctx: unknown,
    _addr: string,
    fn: (s: unknown) => unknown
  ) => fn({}),
}));

vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsRole: vi.fn(),
  executeContractCallAsSafe: vi.fn(),
}));

vi.mock("@/lib/web3/gas-preflight", () => ({
  preflightGasBalance: () => Promise.resolve(mockGasCheck()),
  resolveFundingHolder: (_m: unknown, addr: string) => addr,
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

import { tradeStockTokenCore } from "@/plugins/robinhood/steps/trade-stock-token-core";

const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const UNIT = BigInt("1000000000000000000");
const HUGE = BigInt("1000000000000000000000000");

const TOKEN = {
  symbol: "AAPL",
  name: "Apple",
  address: AAPL,
  decimals: 18,
  currentMultiplier: "1",
  pendingMultiplier: "",
  active: true,
};

const CLEAN_STATE = {
  uiMultiplier: "1.0",
  unknown: [],
  pendingMultiplier: null,
  effectiveAt: null,
  paused: false,
  tokenPaused: false,
  oraclePaused: false,
};

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    network: "robinhood-mainnet",
    symbol: "AAPL",
    side: "buy" as const,
    amountIn: "100",
    minAmountOut: "0.3",
    poolFee: "3000",
    poolTickSpacing: "60",
    _context: { organizationId: "org1" },
    ...overrides,
  };
}

/**
 * Both allowances plentiful, with an expiry well beyond the trade deadline.
 * Permit2 rewrites an expiration of 0 to block.timestamp on approve, so a
 * stored 0 means "never set" rather than "never expires"; using 0 here would
 * assert the wrong reading of the field.
 */
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 86_400);
function allowancesOk() {
  mockAllowance.mockImplementation((...args: unknown[]) =>
    Promise.resolve(args.length === 3 ? [HUGE, FUTURE, BigInt(0)] : HUGE)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The failover wrapper is transparent here: run the operation as given.
  mockFailover.mockImplementation((op: (p: unknown) => unknown) =>
    Promise.resolve(op({}))
  );
  allowancesOk();
  mockChainId.mockReturnValue(4663);
  mockResolveToken.mockResolvedValue({ ok: true, token: TOKEN });
  mockOnChain.mockResolvedValue(CLEAN_STATE);
  mockResolveForWrite.mockResolvedValue({ ok: true, multiplier: UNIT });
  mockExecute.mockResolvedValue({ hash: "0xdead" });
  mockGasCheck.mockReturnValue({ affordable: true });
});

describe("chain and symbol gates", () => {
  it("refuses a chain other than Robinhood", async () => {
    mockChainId.mockReturnValue(1);
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
  });

  it("refuses an unlisted ticker", async () => {
    mockResolveToken.mockResolvedValue({ ok: false, error: "NOPE not listed" });
    const r = await tradeStockTokenCore(baseInput({ symbol: "NOPE" }));
    expect(r.success).toBe(false);
  });
});

describe("trading gates", () => {
  it.each([
    ["paused", { paused: true }],
    ["transfers paused", { tokenPaused: true }],
    ["oracle paused", { oraclePaused: true }],
    ["corporate action pending", { pendingMultiplier: "4.0" }],
  ])("refuses when %s", async (_label, patch) => {
    mockOnChain.mockResolvedValue({ ...CLEAN_STATE, ...patch });
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses when a pause flag could not be read", async () => {
    // An unreadable flag is not a clear flag, and this is a fund-moving path.
    mockOnChain.mockResolvedValue({ ...CLEAN_STATE, unknown: ["paused"] });
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses when the multiplier cannot be read", async () => {
    mockResolveForWrite.mockResolvedValue({
      ok: false,
      error: new Error("could not read multiplier"),
    });
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("Permit2 allowances", () => {
  it("refuses and names the missing token approval", async () => {
    mockAllowance.mockImplementation((...args: unknown[]) =>
      Promise.resolve(args.length === 3 ? [HUGE, FUTURE, BigInt(0)] : BigInt(0))
    );
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/Permit2/);
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses when Permit2 has not authorised the router", async () => {
    mockAllowance.mockImplementation((...args: unknown[]) =>
      Promise.resolve(args.length === 3 ? [BigInt(0), FUTURE, BigInt(0)] : HUGE)
    );
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/Universal Router/);
    }
  });

  it("refuses an expired Permit2 allowance", async () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600);
    mockAllowance.mockImplementation((...args: unknown[]) =>
      Promise.resolve(args.length === 3 ? [HUGE, past, BigInt(0)] : HUGE)
    );
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/expires too soon|never set/);
    }
  });
});

describe("a clean trade", () => {
  it("broadcasts and reports the pool it used", async () => {
    allowancesOk();
    const r = await tradeStockTokenCore(baseInput());
    expect(r).toMatchObject({
      success: true,
      transactionHash: "0xdead",
      symbol: "AAPL",
      side: "buy",
      poolFee: 3000,
      poolTickSpacing: 60,
    });
  });

  it("rejects a non-integer pool key before touching the chain", async () => {
    const r = await tradeStockTokenCore(baseInput({ poolFee: "not-a-number" }));
    expect(r.success).toBe(false);
    expect(mockOnChain).not.toHaveBeenCalled();
  });
});

describe("refusals added after review", () => {
  it("refuses a deadline that is not a positive whole number", async () => {
    const r = await tradeStockTokenCore(baseInput({ deadlineSeconds: "5m" }));
    // Must be a refusal, not a RangeError escaping the step.
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses a negative deadline rather than building a past one", async () => {
    const r = await tradeStockTokenCore(baseInput({ deadlineSeconds: "-100" }));
    expect(r.success).toBe(false);
  });

  it("refuses a Permit2 allowance that lapses before the deadline", async () => {
    const soon = BigInt(Math.floor(Date.now() / 1000) + 10);
    mockAllowance.mockImplementation((...args: unknown[]) =>
      Promise.resolve(args.length === 3 ? [HUGE, soon, BigInt(0)] : HUGE)
    );
    const r = await tradeStockTokenCore(baseInput({ deadlineSeconds: "300" }));
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses when the wallet cannot pay for gas, before taking the nonce lock", async () => {
    mockGasCheck.mockReturnValue({
      affordable: false,
      message: "insufficient gas",
    } as never);
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses when the pending-action reads could not be made", async () => {
    mockOnChain.mockResolvedValue({
      ...CLEAN_STATE,
      unknown: ["newUIMultiplier"],
    });
    const r = await tradeStockTokenCore(baseInput());
    expect(r.success).toBe(false);
  });
});
