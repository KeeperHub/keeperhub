import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
// Real error classes so the type guards inside the helper work.
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import {
  SponsoredTxPendingError,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";

const CTX = { logPrefix: "[Test]", actionName: "write-contract", chainId: 1 };

describe("resolveSponsoredSendError", () => {
  it("does not fall back on an on-chain revert", () => {
    const error = new SponsoredTxRevertError({
      message: "Guard/not-allowed",
      txHash: "0xabc",
      sendTransactionStatusId: "sid",
      revertChain: [],
    });

    const decision = resolveSponsoredSendError(error, CTX);

    expect(decision.fallback).toBe(false);
    expect(decision).toMatchObject({
      error: "Transaction reverted: Guard/not-allowed (tx 0xabc)",
      transactionHash: "0xabc",
    });
    // No errorClass: a clean, terminal revert stays eligible for
    // applyFailOnError's softening, same as a direct-signing revert.
    if (!decision.fallback) {
      expect(decision.errorClass).toBeUndefined();
    }
  });

  it("does not fall back when the sponsored send is submitted but unconfirmed", () => {
    const error = new SponsoredTxPendingError({
      message: "outcome unknown",
      sendTransactionStatusId: "sid",
    });

    const decision = resolveSponsoredSendError(error, CTX);

    expect(decision.fallback).toBe(false);
    expect(decision).toMatchObject({
      error: expect.stringContaining("not confirmed"),
      errorClass: ExecutionErrorType.SYSTEM,
    });
    // No hash was ever assigned, so there is nothing to reconcile against.
    if (!decision.fallback) {
      expect(decision.transactionHash).toBeUndefined();
    }
  });

  it("surfaces the hash of a broadcast whose outcome could not be read", () => {
    const error = new SponsoredTxPendingError({
      message: "receipt unreadable",
      sendTransactionStatusId: "sid",
      txHash: "0xbroadcast",
    });

    const decision = resolveSponsoredSendError(error, CTX);

    expect(decision.fallback).toBe(false);
    // The execution record needs the hash: without it the transaction exists
    // on-chain and nowhere in our data.
    expect(decision).toMatchObject({
      transactionHash: "0xbroadcast",
      errorClass: ExecutionErrorType.SYSTEM,
    });
  });

  it("falls back to direct signing on a generic pre-broadcast error", () => {
    const decision = resolveSponsoredSendError(new Error("boom"), CTX);

    expect(decision.fallback).toBe(true);
  });
});
