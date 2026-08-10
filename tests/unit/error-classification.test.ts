import { describe, expect, it } from "vitest";
import {
  isNonRetryableError,
  NON_RETRYABLE_ERROR_CODES,
} from "@/lib/rpc/providers/error-classification";

describe("isNonRetryableError", () => {
  it("returns false for non-object errors", () => {
    expect(isNonRetryableError("timeout")).toBe(false);
    expect(isNonRetryableError(null)).toBe(false);
    expect(isNonRetryableError(undefined)).toBe(false);
    expect(isNonRetryableError(42)).toBe(false);
  });

  it("returns false for objects without a code property", () => {
    expect(isNonRetryableError({ message: "oops" })).toBe(false);
  });

  it("returns true for each non-retryable error code", () => {
    for (const code of NON_RETRYABLE_ERROR_CODES) {
      expect(isNonRetryableError({ code, message: "test" })).toBe(true);
    }
  });

  it("does not change live failover policy for INSUFFICIENT_FUNDS", () => {
    expect(NON_RETRYABLE_ERROR_CODES.has("INSUFFICIENT_FUNDS")).toBe(false);
    expect(
      isNonRetryableError({
        code: "INSUFFICIENT_FUNDS",
        message: "insufficient funds for gas * price + value",
      })
    ).toBe(false);
  });

  it("returns false for retryable error codes", () => {
    expect(isNonRetryableError({ code: "NETWORK_ERROR" })).toBe(false);
    expect(isNonRetryableError({ code: "SERVER_ERROR" })).toBe(false);
    expect(isNonRetryableError({ code: "TIMEOUT" })).toBe(false);
    expect(isNonRetryableError({ code: "UNKNOWN_ERROR" })).toBe(false);
  });

  it('treats BAD_DATA with "missing response for request" as retryable', () => {
    expect(
      isNonRetryableError({
        code: "BAD_DATA",
        message: "missing response for request",
      })
    ).toBe(false);
  });

  it("treats BAD_DATA with other messages as non-retryable", () => {
    expect(
      isNonRetryableError({
        code: "BAD_DATA",
        message: "could not decode result data",
      })
    ).toBe(true);
  });

  it("treats BAD_DATA with empty message as non-retryable", () => {
    expect(isNonRetryableError({ code: "BAD_DATA", message: "" })).toBe(true);
  });

  it("falls back to shortMessage when message is missing for BAD_DATA", () => {
    expect(
      isNonRetryableError({
        code: "BAD_DATA",
        message: undefined,
        shortMessage: "missing response for request",
      })
    ).toBe(false);

    expect(
      isNonRetryableError({
        code: "BAD_DATA",
        message: undefined,
        shortMessage: "malformed ABI",
      })
    ).toBe(true);
  });
});
