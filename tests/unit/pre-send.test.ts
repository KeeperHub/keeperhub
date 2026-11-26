import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertGasLimitFits,
  GasLimitTooLowError,
} from "@/lib/web3/gas-limit-error";
import { broadcastAttemptedOf } from "@/lib/web3/pre-send";
import { PreBroadcastNetworkError } from "@/lib/web3/submit-signed";

const UNKNOWN = { kind: "unknown" } as const;

function tooHigh(): unknown {
  try {
    assertGasLimitFits(BigInt(20_000_000), 1, BigInt(30_000_000));
  } catch (error) {
    return error;
  }
  throw new Error("expected a too-high Gas Limit");
}

describe("broadcastAttemptedOf", () => {
  it("knows a refused connection and a Gas Limit too low or too high as nothing sent", () => {
    for (const error of [
      new PreBroadcastNetworkError("refused", undefined),
      new GasLimitTooLowError(BigInt(20_000), {}),
      tooHigh(),
    ]) {
      expect(broadcastAttemptedOf(error, undefined, UNKNOWN)).toBe(false);
    }
  });

  it("fails closed on anything else", () => {
    expect(
      broadcastAttemptedOf(new Error("missing revert data"), undefined, UNKNOWN)
    ).toBe(true);
    expect(broadcastAttemptedOf(undefined, undefined, UNKNOWN)).toBe(true);
  });

  it("is false for a node's rejection and true whenever a hash exists", () => {
    const refused = new PreBroadcastNetworkError("refused", undefined);
    expect(
      broadcastAttemptedOf(new Error("x"), undefined, {
        kind: "string-revert",
        reason: "x",
      })
    ).toBe(false);
    expect(broadcastAttemptedOf(refused, "0xabc", UNKNOWN)).toBe(true);
    expect(broadcastAttemptedOf(new Error("x"), null, UNKNOWN)).toBe(true);
  });
});
