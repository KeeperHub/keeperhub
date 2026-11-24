import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GasLimitTooHighError,
  GasLimitTooLowError,
} from "@/lib/web3/gas-limit-error";
import { isDefinitelyPreSend } from "@/lib/web3/pre-send";
import { PreBroadcastNetworkError } from "@/lib/web3/submit-signed";

describe("isDefinitelyPreSend", () => {
  it("knows a refused connection and a Gas Limit too low or too high as nothing sent", () => {
    expect(
      isDefinitelyPreSend(new PreBroadcastNetworkError("refused", undefined))
    ).toBe(true);
    expect(
      isDefinitelyPreSend(new GasLimitTooLowError(BigInt(20_000), {}))
    ).toBe(true);
    expect(
      isDefinitelyPreSend(
        new GasLimitTooHighError(BigInt(20_000_000), BigInt(16_777_216))
      )
    ).toBe(true);
  });

  it("fails closed on anything else", () => {
    expect(isDefinitelyPreSend(new Error("missing revert data"))).toBe(false);
    expect(isDefinitelyPreSend(undefined)).toBe(false);
  });
});
