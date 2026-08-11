import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  formatRevertChain,
  isSponsoredTxRevertError,
  type RevertChainEntry,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";

describe("SponsoredTxRevertError", () => {
  it("carries the structured revert details", () => {
    const err = new SponsoredTxRevertError({
      message: "execution reverted",
      txHash: "0xabc",
      sendTransactionStatusId: "status-1",
      revertChain: [{ displayMessage: "boom" }],
    });

    expect(err.name).toBe("SponsoredTxRevertError");
    expect(err.txHash).toBe("0xabc");
    expect(err.sendTransactionStatusId).toBe("status-1");
    expect(err.revertChain).toHaveLength(1);
  });
});

describe("isSponsoredTxRevertError", () => {
  it("recognises the typed error across module boundaries", () => {
    const err = new SponsoredTxRevertError({
      message: "x",
      txHash: "0xabc",
      sendTransactionStatusId: "s",
      revertChain: [],
    });

    expect(isSponsoredTxRevertError(err)).toBe(true);
  });

  it("rejects plain Error and unrelated values", () => {
    expect(isSponsoredTxRevertError(new Error("nope"))).toBe(false);
    expect(isSponsoredTxRevertError(null)).toBe(false);
    expect(isSponsoredTxRevertError({ kind: "sponsored-tx-revert" })).toBe(
      false
    );
  });
});

describe("formatRevertChain", () => {
  it("falls back to generic message for empty chain", () => {
    expect(formatRevertChain([])).toBe("execution reverted");
  });

  it("prefers decoded custom error name and params", () => {
    const chain: RevertChainEntry[] = [
      {
        address: "0x1111111111111111111111111111111111111111",
        errorType: "custom",
        custom: {
          errorName: "InsufficientBalance",
          paramsJson: '{"have":1,"need":2}',
        },
      },
    ];

    expect(formatRevertChain(chain)).toBe(
      'InsufficientBalance({"have":1,"need":2}) at 0x1111111111111111111111111111111111111111'
    );
  });

  it("uses the Solidity message for native errors", () => {
    const chain: RevertChainEntry[] = [
      {
        errorType: "native",
        native: { nativeType: "error_string", message: "INVALID_ROUTER" },
      },
    ];

    expect(formatRevertChain(chain)).toBe("INVALID_ROUTER");
  });

  it("renders the selector when the contract error is unknown", () => {
    const chain: RevertChainEntry[] = [
      {
        errorType: "unknown",
        unknown: { selector: "0x12345678", data: "0x12345678deadbeef" },
      },
    ];

    expect(formatRevertChain(chain)).toBe(
      "unknown error (selector 0x12345678)"
    );
  });

  it("joins nested reverts outermost-to-innermost", () => {
    const chain: RevertChainEntry[] = [
      {
        address: "0xaaa",
        native: { nativeType: "error_string", message: "Outer failure" },
      },
      {
        address: "0xbbb",
        custom: { errorName: "InnerError", paramsJson: '{"x":1}' },
      },
    ];

    expect(formatRevertChain(chain)).toBe(
      'Outer failure at 0xaaa -> InnerError({"x":1}) at 0xbbb'
    );
  });
});
