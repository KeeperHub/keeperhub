import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
}));

import {
  isOnChainRevertError,
  OnChainRevertError,
  revertedTransactionHash,
} from "@/lib/web3/onchain-revert";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { SponsoredTxRevertError } from "@/lib/web3/turnkey-revert";

const HASH =
  "0x3d65002347c5f59f51e13cfc94d7cdbd4b1cf76304bee9c54707970286358ed2";

describe("OnChainRevertError", () => {
  it("keeps the hash reachable without parsing the message", () => {
    const error = new OnChainRevertError({
      message: `Transaction ${HASH} reverted on-chain (status 0, block 11413412)`,
      transactionHash: HASH,
      blockNumber: 11_413_412,
    });

    expect(isOnChainRevertError(error)).toBe(true);
    expect(revertedTransactionHash(error)).toBe(HASH);
    expect(error.blockNumber).toBe(11_413_412);
  });

  it("preserves the message so message-only callers are unaffected", () => {
    const message = `Transaction ${HASH} reverted on-chain (status 0, block 11413412)`;
    const error = new OnChainRevertError({ message, transactionHash: HASH });

    expect(error.message).toBe(message);
    expect(error instanceof Error).toBe(true);
  });

  it("reports no hash for a pre-broadcast failure", () => {
    // Nothing reached the chain, so there is nothing to reconcile and the
    // finalizer must not record a transaction that does not exist.
    expect(
      revertedTransactionHash(new Error("insufficient funds"))
    ).toBeUndefined();
    expect(isOnChainRevertError(new Error("boom"))).toBe(false);
    expect(revertedTransactionHash(undefined)).toBeUndefined();
  });
});

describe("resolveSponsoredSendError", () => {
  const ctx = {
    logPrefix: "[Write Contract]",
    actionName: "write-contract",
    chainId: 11_155_111,
  };

  it("surfaces the hash of a sponsored transaction that reverted on-chain", () => {
    const decision = resolveSponsoredSendError(
      new SponsoredTxRevertError({
        message: "execution reverted",
        txHash: HASH,
        sendTransactionStatusId: "sts_1",
        revertChain: [],
      }),
      ctx
    );

    expect(decision.fallback).toBe(false);
    if (decision.fallback === false) {
      expect(decision.transactionHash).toBe(HASH);
      // The message keeps the hash too, so existing consumers still work.
      expect(decision.error).toContain(HASH);
    }
  });

  it("carries no hash when a pre-broadcast failure falls back to direct signing", () => {
    const decision = resolveSponsoredSendError(new Error("policy denied"), ctx);

    expect(decision.fallback).toBe(true);
  });
});
