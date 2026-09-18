import { describe, expect, it } from "vitest";

import {
  isConnectionFailure,
  isRetryableHttpStatus,
  linearBackoffMs,
  parseRetryAfterHeaderMs,
  RETRYABLE_HTTP_STATUS,
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";

const ATTEMPTS = { defaultAttempts: 0, maxAttempts: 5 };
const DELAY = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };

describe("resolveRetryAttempts boundaries", () => {
  it.each([
    [undefined, 0],
    [null, 0],
    ["", 0],
    ["abc", 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("falls back to the default for %p", (raw, expected) => {
    expect(resolveRetryAttempts(raw, ATTEMPTS)).toBe(expected);
  });

  it("uses a non-zero default when the caller sets one", () => {
    expect(
      resolveRetryAttempts(undefined, { defaultAttempts: 3, maxAttempts: 5 })
    ).toBe(3);
  });

  it.each([
    [-1, 0],
    [-0.5, 0],
    [0, 0],
    [1, 1],
    [4, 4],
    [5, 5],
    [6, 5],
    [99, 5],
  ])("clamps %p to %p", (raw, expected) => {
    expect(resolveRetryAttempts(raw, ATTEMPTS)).toBe(expected);
  });

  it("truncates fractions rather than rounding", () => {
    expect(resolveRetryAttempts(2.9, ATTEMPTS)).toBe(2);
    expect(resolveRetryAttempts("4.99", ATTEMPTS)).toBe(4);
  });

  it("coerces editor strings, including padded ones", () => {
    expect(resolveRetryAttempts("3", ATTEMPTS)).toBe(3);
    expect(resolveRetryAttempts(" 2 ", ATTEMPTS)).toBe(2);
    expect(resolveRetryAttempts("5", ATTEMPTS)).toBe(5);
    expect(resolveRetryAttempts("6", ATTEMPTS)).toBe(5);
  });
});

describe("resolveRetryDelayMs boundaries", () => {
  it.each([
    [undefined, 1000],
    [null, 1000],
    ["", 1000],
    ["abc", 1000],
    [Number.NaN, 1000],
  ])("falls back to the default for %p", (raw, expected) => {
    expect(resolveRetryDelayMs(raw, DELAY)).toBe(expected);
  });

  it.each([
    [-5, 0],
    [0, 0],
    [0.5, 500],
    [1, 1000],
    [14.999, 14_999],
    [15, 15_000],
    [15.001, 15_000],
    [60, 15_000],
  ])("clamps %p seconds to %p ms", (raw, expected) => {
    expect(resolveRetryDelayMs(raw, DELAY)).toBe(expected);
  });

  it("respects a wider cap when the caller allows it", () => {
    expect(
      resolveRetryDelayMs(30, { defaultDelaySeconds: 1, maxDelaySeconds: 30 })
    ).toBe(30_000);
    expect(
      resolveRetryDelayMs(31, { defaultDelaySeconds: 1, maxDelaySeconds: 30 })
    ).toBe(30_000);
  });

  it("coerces editor strings", () => {
    expect(resolveRetryDelayMs("5", DELAY)).toBe(5000);
    expect(resolveRetryDelayMs("0", DELAY)).toBe(0);
  });
});

describe("retryable statuses", () => {
  it("matches the HTTP Request node's set exactly", () => {
    expect([...RETRYABLE_HTTP_STATUS].sort((a, b) => a - b)).toEqual([
      408, 425, 429, 500, 502, 503, 504,
    ]);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("retries %i", (status) => {
    expect(isRetryableHttpStatus(status)).toBe(true);
  });

  it.each([200, 204, 400, 401, 403, 404, 409, 422, 501, 505])(
    "does not retry %i",
    (status) => {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  );
});

describe("linearBackoffMs", () => {
  it("scales the base delay by the retry number", () => {
    expect(linearBackoffMs(1000, 1)).toBe(1000);
    expect(linearBackoffMs(1000, 2)).toBe(2000);
    expect(linearBackoffMs(1000, 5)).toBe(5000);
  });

  it("is zero when the base delay is zero", () => {
    expect(linearBackoffMs(0, 3)).toBe(0);
  });
});

describe("parseRetryAfterHeaderMs", () => {
  it.each([
    [null, undefined],
    [undefined, undefined],
    ["", undefined],
    ["-1", undefined],
    ["abc", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ])("returns undefined for %p", (header, expected) => {
    expect(parseRetryAfterHeaderMs(header)).toBe(expected);
  });

  it("converts delta-seconds to milliseconds, rounding up", () => {
    expect(parseRetryAfterHeaderMs("0")).toBe(0);
    expect(parseRetryAfterHeaderMs("2")).toBe(2000);
    expect(parseRetryAfterHeaderMs("1.2345")).toBe(1235);
    expect(parseRetryAfterHeaderMs(" 3 ")).toBe(3000);
  });
});

describe("isConnectionFailure", () => {
  function withCode(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  it.each([
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
  ])("recognises %s on the error itself", (code) => {
    expect(isConnectionFailure(withCode(code))).toBe(true);
  });

  it("looks through undici's TypeError wrapper to the cause", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: withCode("ECONNREFUSED"),
    });
    expect(isConnectionFailure(wrapped)).toBe(true);
  });

  it("recognises safeFetch's own DNS failure message", () => {
    expect(
      isConnectionFailure(new Error("Cannot resolve host: example.test"))
    ).toBe(true);
  });

  it.each(["ECONNRESET", "EPIPE", "ETIMEDOUT"])(
    "does not treat %s as proof the request never left",
    (code) => {
      expect(isConnectionFailure(withCode(code))).toBe(false);
    }
  );

  it("does not treat an abort timeout as a connection failure", () => {
    const abort = new DOMException("The operation was aborted", "TimeoutError");
    expect(isConnectionFailure(abort)).toBe(false);
  });

  it.each([undefined, null, "string", 42, new Error("boom")])(
    "returns false for %p",
    (value) => {
      expect(isConnectionFailure(value)).toBe(false);
    }
  );

  it("stops walking a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(isConnectionFailure(a)).toBe(false);
  });
});
