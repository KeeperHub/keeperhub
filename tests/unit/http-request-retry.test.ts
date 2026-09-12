import { beforeEach, describe, expect, it, vi } from "vitest";

// The HTTP Request step retries transient failures itself, so a flaky source
// no longer needs a hand-written retry loop in a Code node.

vi.mock("server-only", () => ({}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation" },
  logUserError: vi.fn(),
}));

import { SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
import {
  httpRequest,
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/nodes/http-request/perform";

const mockedSafeFetch = vi.mocked(safeFetch);

function mockResponse(
  ok: boolean,
  status: number,
  body: unknown = {}
): Response {
  return {
    ok,
    status,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const BASE_INPUT = {
  endpoint: "https://api.example.com/rpc",
  httpMethod: "POST",
  // Zero delay keeps the tests instant; the backoff itself is covered by
  // resolveRetryDelayMs.
  retryDelay: 0,
};

describe("resolveRetryAttempts", () => {
  it("defaults to no retries", () => {
    expect(resolveRetryAttempts(undefined)).toBe(0);
    expect(resolveRetryAttempts("")).toBe(0);
    expect(resolveRetryAttempts(null)).toBe(0);
  });

  it("coerces a string from the visual editor", () => {
    expect(resolveRetryAttempts("3")).toBe(3);
  });

  it("clamps to the 0-5 range", () => {
    expect(resolveRetryAttempts(-2)).toBe(0);
    expect(resolveRetryAttempts(99)).toBe(5);
  });

  it("falls back to no retries for junk", () => {
    expect(resolveRetryAttempts("abc")).toBe(0);
  });
});

describe("resolveRetryDelayMs", () => {
  it("defaults to one second", () => {
    expect(resolveRetryDelayMs(undefined)).toBe(1000);
  });

  it("allows zero", () => {
    expect(resolveRetryDelayMs(0)).toBe(0);
  });

  it("clamps to the 30s maximum", () => {
    expect(resolveRetryDelayMs(120)).toBe(30_000);
  });
});

describe("httpRequest retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes a single attempt when retries are off", async () => {
    mockedSafeFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await httpRequest({ ...BASE_INPUT });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("retries a connection error and succeeds on a later attempt", async () => {
    mockedSafeFetch
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(mockResponse(true, 200, { result: "ok" }));

    const result = await httpRequest({ ...BASE_INPUT, retryAttempts: 2 });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      status: 200,
      data: { result: "ok" },
    });
  });

  it("stops after the configured number of extra attempts", async () => {
    mockedSafeFetch.mockRejectedValue(new Error("timeout"));

    const result = await httpRequest({ ...BASE_INPUT, retryAttempts: 3 });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(false);
  });

  it("retries a 503 and a 429", async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockResponse(false, 503))
      .mockResolvedValueOnce(mockResponse(false, 429))
      .mockResolvedValueOnce(mockResponse(true, 200, { ok: true }));

    const result = await httpRequest({ ...BASE_INPUT, retryAttempts: 2 });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
  });

  it("does not retry a 404", async () => {
    mockedSafeFetch.mockResolvedValue(mockResponse(false, 404));

    const result = await httpRequest({ ...BASE_INPUT, retryAttempts: 3 });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, status: 404 });
  });

  it("never retries a blocked URL", async () => {
    mockedSafeFetch.mockRejectedValue(
      new SsrfBlockedError({
        hostname: "10.0.0.1",
        reason: "private-ip",
        message: "private address",
      })
    );

    const result = await httpRequest({ ...BASE_INPUT, retryAttempts: 3 });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("soft-fails after exhausting retries when failOnError is off", async () => {
    mockedSafeFetch.mockRejectedValue(new Error("timeout"));

    const result = await httpRequest({
      ...BASE_INPUT,
      retryAttempts: 1,
      failOnError: false,
    });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true, data: null, status: null });
  });

  it("soft-fails with the status after exhausting retries on a 5xx", async () => {
    mockedSafeFetch.mockResolvedValue(mockResponse(false, 500));

    const result = await httpRequest({
      ...BASE_INPUT,
      retryAttempts: 1,
      failOnError: false,
    });

    expect(mockedSafeFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true, data: null, status: 500 });
  });
});
