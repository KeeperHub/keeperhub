import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthorizationState } = vi.hoisted(() => ({
  mockAuthorizationState: vi.fn(),
}));

vi.mock("ethers", () => {
  class MockJsonRpcProvider {}
  class MockContract {
    authorizationState = mockAuthorizationState;
  }
  return {
    JsonRpcProvider: MockJsonRpcProvider,
    Contract: MockContract,
  };
});

describe("isTimeoutError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: returns true for 'context deadline exceeded'", async () => {
    const { isTimeoutError } = await import("@/lib/payments/x402/reconcile");
    expect(isTimeoutError("context deadline exceeded")).toBe(true);
  });

  it("Test 2: returns true for 'did not confirm in time'", async () => {
    const { isTimeoutError } = await import("@/lib/payments/x402/reconcile");
    expect(isTimeoutError("did not confirm in time")).toBe(true);
  });

  it("Test 3: returns true for 'unable to estimate gas'", async () => {
    const { isTimeoutError } = await import("@/lib/payments/x402/reconcile");
    expect(isTimeoutError("unable to estimate gas")).toBe(true);
  });

  it("Test 4: returns false for 'invalid_payload'", async () => {
    const { isTimeoutError } = await import("@/lib/payments/x402/reconcile");
    expect(isTimeoutError("invalid_payload")).toBe(false);
  });

  it("Test 5: returns false for 'insufficient balance'", async () => {
    const { isTimeoutError } = await import("@/lib/payments/x402/reconcile");
    expect(isTimeoutError("insufficient balance")).toBe(false);
  });
});

describe("pollForPaymentConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 6: returns true when nonce is already used on first poll", async () => {
    mockAuthorizationState.mockResolvedValue(BigInt(1));
    const { pollForPaymentConfirmation } = await import(
      "@/lib/payments/x402/reconcile"
    );
    const result = await pollForPaymentConfirmation({
      payerAddress: "0xPAYER",
      nonce: "0xNONCE",
      maxWaitMs: 200,
      intervalMs: 10,
    });
    expect(result).toBe(true);
  });

  it("Test 7: returns true when nonce becomes used on second poll", async () => {
    mockAuthorizationState
      .mockResolvedValueOnce(BigInt(0))
      .mockResolvedValueOnce(BigInt(1));

    const { pollForPaymentConfirmation } = await import(
      "@/lib/payments/x402/reconcile"
    );

    const resultPromise = pollForPaymentConfirmation({
      payerAddress: "0xPAYER",
      nonce: "0xNONCE",
      maxWaitMs: 200,
      intervalMs: 10,
    });

    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it("Test 8: returns false when nonce is never used within timeout", async () => {
    mockAuthorizationState.mockResolvedValue(BigInt(0));

    const { pollForPaymentConfirmation } = await import(
      "@/lib/payments/x402/reconcile"
    );

    const resultPromise = pollForPaymentConfirmation({
      payerAddress: "0xPAYER",
      nonce: "0xNONCE",
      maxWaitMs: 50,
      intervalMs: 10,
    });

    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe(false);
  });

  it("Test 9: returns false immediately when nonce is cancelled", async () => {
    mockAuthorizationState.mockResolvedValue(BigInt(2));

    const { pollForPaymentConfirmation } = await import(
      "@/lib/payments/x402/reconcile"
    );

    const result = await pollForPaymentConfirmation({
      payerAddress: "0xPAYER",
      nonce: "0xNONCE",
      maxWaitMs: 5000,
      intervalMs: 1000,
    });
    expect(result).toBe(false);
    // Should only call once (immediate return on cancelled)
    expect(mockAuthorizationState).toHaveBeenCalledTimes(1);
  });
});
