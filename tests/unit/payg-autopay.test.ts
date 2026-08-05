import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// --- On-chain settlement plumbing: drive settleViaFacilitator's outcome. ---
const facilitatorSettle = vi.fn();
vi.mock("@/lib/payments/x402/server", () => ({
  facilitatorClient: { settle: (...a: unknown[]) => facilitatorSettle(...a) },
}));
vi.mock("@x402/evm/exact/client", () => ({
  ExactEvmScheme: class {
    createPaymentPayload() {
      return Promise.resolve({ x402Version: 2, payload: {} });
    }
  },
}));
vi.mock("@/lib/agentic-wallet/sign-typed-data", () => ({
  signTypedDataWithTurnkey: vi.fn(async () => "0xsig"),
}));
vi.mock("@/lib/agentic-wallet/constants", () => ({
  USDC_BASE_ADDRESS: "0xusdc",
}));
vi.mock("@/lib/address-utils", () => ({
  toChecksumAddress: (address: string) => address,
}));

// --- Config / wallet / pricing / treasury, driven per test via state. ---
const state = vi.hoisted(() => ({
  config: {
    chainId: 8453,
    dailyCapRaw: "1000000",
    periodCapRaw: "1000000",
    startedAt: new Date("2026-01-01T00:00:00Z"),
  },
  wallet: null as null | {
    turnkeySubOrgId: string | null;
    walletAddress: string;
  },
  price: BigInt(10_000),
  treasury: null as string | null,
}));
vi.mock("@/lib/billing/payg/config-store", () => ({
  getPaygSettings: vi.fn(async () => state.config),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: vi.fn(async () => state.wallet),
}));
vi.mock("@/lib/billing/payg/pricing", () => ({
  getPaygExecutionPriceRaw: vi.fn(() => state.price),
}));
vi.mock("@/lib/billing/payg/treasury", () => ({
  getPaygTreasuryOrNull: vi.fn(() => state.treasury),
}));

// --- Payments helpers: spies configured per test. ---
const findPaygPayment = vi.fn();
const claimPaygPayment = vi.fn();
const getPaygSpentRaw = vi.fn();
const markPaygPaymentSettled = vi.fn();
const releasePaygClaim = vi.fn();
vi.mock("@/lib/billing/payg/payments", () => ({
  findPaygPayment: (...a: unknown[]) => findPaygPayment(...a),
  claimPaygPayment: (...a: unknown[]) => claimPaygPayment(...a),
  getPaygSpentRaw: (...a: unknown[]) => getPaygSpentRaw(...a),
  markPaygPaymentSettled: (...a: unknown[]) => markPaygPaymentSettled(...a),
  releasePaygClaim: (...a: unknown[]) => releasePaygClaim(...a),
}));

import { autopayForExecution } from "@/lib/billing/payg/autopay";

const PARAMS = { organizationId: "org_1", executionId: "exec_1" };

beforeEach(() => {
  vi.clearAllMocks();
  // Caps well above the per-execution price, so only the tests that set a
  // tighter cap exercise the guard.
  state.config = {
    chainId: 8453,
    dailyCapRaw: "1000000",
    periodCapRaw: "1000000",
    startedAt: new Date("2026-01-01T00:00:00Z"),
  };
  state.wallet = { turnkeySubOrgId: "sub_1", walletAddress: "0xabc" };
  state.price = BigInt(10_000);
  state.treasury = "0xtreasury";
  // Defaults: no prior row, claim wins, no reserved spend, settlement succeeds.
  findPaygPayment.mockResolvedValue(null);
  claimPaygPayment.mockResolvedValue(true);
  getPaygSpentRaw.mockResolvedValue(BigInt(0));
  markPaygPaymentSettled.mockResolvedValue(undefined);
  releasePaygClaim.mockResolvedValue(undefined);
  facilitatorSettle.mockResolvedValue({ success: true, transaction: "0xtx" });
});

describe("autopayForExecution claim-before-settle", () => {
  it("claims a pending row, settles, then marks it settled", async () => {
    const order: string[] = [];
    claimPaygPayment.mockImplementation(() => {
      order.push("claim");
      return Promise.resolve(true);
    });
    facilitatorSettle.mockImplementation(() => {
      order.push("settle");
      return Promise.resolve({ success: true, transaction: "0xtx" });
    });

    const result = await autopayForExecution(PARAMS);

    // The row is claimed as pending BEFORE the on-chain transfer.
    expect(order).toEqual(["claim", "settle"]);
    expect(claimPaygPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        executionId: "exec_1",
        amountRaw: "10000",
        status: "pending",
      })
    );
    expect(markPaygPaymentSettled).toHaveBeenCalledWith(
      "org_1",
      "exec_1",
      "0xtx"
    );
    expect(releasePaygClaim).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      txHash: "0xtx",
      amountRaw: BigInt(10_000),
    });
  });

  it("returns the recorded tx without re-settling when already settled", async () => {
    findPaygPayment.mockResolvedValue({
      txHash: "0xprev",
      amountRaw: "10000",
      status: "settled",
    });

    const result = await autopayForExecution(PARAMS);

    expect(claimPaygPayment).not.toHaveBeenCalled();
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      txHash: "0xprev",
      amountRaw: BigInt(10_000),
    });
  });

  it("refuses without re-settling when a pending row already exists", async () => {
    // A pending row means another attempt is mid-settle or crashed after
    // settling; re-settling would double-charge (x402 uses a fresh nonce).
    findPaygPayment.mockResolvedValue({
      txHash: null,
      amountRaw: "10000",
      status: "pending",
    });

    const result = await autopayForExecution(PARAMS);

    expect(claimPaygPayment).not.toHaveBeenCalled();
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "payment_failed" });
  });

  it("backs off without settling when a concurrent caller won the claim", async () => {
    findPaygPayment
      .mockResolvedValueOnce(null) // initial idempotency check: nothing yet
      .mockResolvedValueOnce({
        txHash: "0xother",
        amountRaw: "10000",
        status: "settled",
      }); // the winner's settled row
    claimPaygPayment.mockResolvedValue(false); // lost the insert race

    const result = await autopayForExecution(PARAMS);

    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(releasePaygClaim).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      txHash: "0xother",
      amountRaw: BigInt(10_000),
    });
  });

  it("releases the claim and returns daily_cap when the reserved total exceeds the daily cap", async () => {
    state.config = {
      chainId: 8453,
      dailyCapRaw: "10000",
      periodCapRaw: "1000000",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    };
    getPaygSpentRaw.mockResolvedValue(BigInt(20_000)); // reserved (incl. claim) > cap

    const result = await autopayForExecution(PARAMS);

    expect(claimPaygPayment).toHaveBeenCalledTimes(1);
    expect(getPaygSpentRaw).toHaveBeenCalledWith(
      "org_1",
      expect.any(Date),
      undefined,
      { includePending: true }
    );
    expect(releasePaygClaim).toHaveBeenCalledWith("org_1", "exec_1");
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("releases the claim and returns period_cap when the reserved total exceeds the period cap", async () => {
    state.config = {
      chainId: 8453,
      dailyCapRaw: "1000000",
      periodCapRaw: "10000",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    };
    getPaygSpentRaw.mockResolvedValue(BigInt(20_000));

    const result = await autopayForExecution(PARAMS);

    expect(releasePaygClaim).toHaveBeenCalledWith("org_1", "exec_1");
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "period_cap" });
  });

  // A cap of 0 means spend nothing. It is refused before the claim, so it holds
  // even when the reserved total reads as 0 (an empty window), which is what a
  // "reserved > cap" comparison alone would let through.
  it("blocks on a daily cap of 0 without claiming, even with zero reserved", async () => {
    state.config = {
      chainId: 8453,
      dailyCapRaw: "0",
      periodCapRaw: "1000000",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    };
    getPaygSpentRaw.mockResolvedValue(BigInt(0));

    const result = await autopayForExecution(PARAMS);

    expect(claimPaygPayment).not.toHaveBeenCalled();
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(markPaygPaymentSettled).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("blocks on a period cap of 0 without claiming, even with zero reserved", async () => {
    state.config = {
      chainId: 8453,
      dailyCapRaw: "1000000",
      periodCapRaw: "0",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    };
    getPaygSpentRaw.mockResolvedValue(BigInt(0));

    const result = await autopayForExecution(PARAMS);

    expect(claimPaygPayment).not.toHaveBeenCalled();
    expect(facilitatorSettle).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "period_cap" });
  });

  it("releases the claim and records nothing when settlement fails", async () => {
    facilitatorSettle.mockResolvedValue({
      success: false,
      errorReason: "insufficient balance",
    });

    const result = await autopayForExecution(PARAMS);

    expect(releasePaygClaim).toHaveBeenCalledWith("org_1", "exec_1");
    expect(markPaygPaymentSettled).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
  });
});
