import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const { logUserError } = vi.hoisted(() => ({ logUserError: vi.fn() }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError,
}));

function connectionRefused(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
}

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

// Discord egress routes through safeFetch (the SSRF guard). Mock it so the
// test asserts on what URL/options the step hands to it, without real network.
const { safeFetch, SsrfBlockedError } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    readonly code = "SSRF_BLOCKED";
  },
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch, SsrfBlockedError }));

// The retry loop waits between attempts. Resolve immediately and record the
// requested waits so the tests stay instant and can assert on the backoff.
const { sleep } = vi.hoisted(() => ({
  sleep: vi.fn((_ms: number) => Promise.resolve()),
}));
vi.mock("@/lib/sleep", () => ({ sleep }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { sendDiscordMessageStep } from "@/plugins/discord/steps/send-message";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";

function runStep(
  webhookUrl: string,
  extra: { retryAttempts?: number | string; retryDelay?: number | string } = {}
) {
  mockFetchCredentials.mockResolvedValue({ webhookUrl });
  return sendDiscordMessageStep({
    integrationId: "int-1",
    discordMessage: "hello",
    ...extra,
  });
}

function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

describe("discord send-message webhook URL validation", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ ok: true, status: 204 });
  });

  // The old check used `webhookUrl.includes("discord.com/api/webhooks/")`,
  // which a URL carrying that string in its PATH satisfies while pointing the
  // host at an internal address. These must be rejected before any egress.
  const bypassUrls = [
    "http://169.254.169.254/discord.com/api/webhooks/123/abc",
    "https://10.0.0.1/discord.com/api/webhooks/123/abc",
    "https://evil.example/discord.com/api/webhooks/123/abc",
  ];

  for (const url of bypassUrls) {
    it(`rejects an off-host URL with the webhook path in its path: ${url}`, async () => {
      const result = await runStep(url);
      expect(result).toEqual({
        success: false,
        error: "Invalid Discord webhook URL format",
        errorClass: ExecutionErrorType.USER,
      });
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-https discord URL", async () => {
    const result = await runStep("http://discord.com/api/webhooks/123/abc");
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong-path discord URL", async () => {
    const result = await runStep("https://discord.com/api/users/@me");
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("accepts a valid discord.com webhook and routes it through safeFetch", async () => {
    const result = await runStep("https://discord.com/api/webhooks/123/abc");

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      { plugin?: string; method?: string },
    ];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(options.plugin).toBe("discord");
    expect(options.method).toBe("POST");
  });

  it("accepts a discord subdomain webhook host (canary)", async () => {
    const result = await runStep(
      "https://canary.discord.com/api/webhooks/123/abc"
    );
    expect(result.success).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("discord send-message retries", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
    sleep.mockClear();
    logUserError.mockClear();
  });

  it("retries a 429 after the wait Discord reports in the body", async () => {
    safeFetch
      .mockResolvedValueOnce(
        mockResponse(429, {
          message: "You are being rate limited.",
          retry_after: 1.5,
        })
      )
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("falls back to the Retry-After header when the 429 body has no retry_after", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result.success).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("stops retrying when Discord asks for a wait longer than 15 seconds", async () => {
    safeFetch.mockResolvedValue(
      mockResponse(429, {
        message: "You are being rate limited.",
        retry_after: 120,
      })
    );

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 5 });

    expect(result).toEqual({
      success: false,
      error: "You are being rate limited.",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying on a global rate limit whatever the wait", async () => {
    safeFetch.mockResolvedValue(
      mockResponse(429, { retry_after: 0.5, global: true })
    );

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 5 });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds every request with a timeout signal", async () => {
    safeFetch.mockResolvedValue(mockResponse(204));

    await runStep(WEBHOOK_URL);

    const [, options] = safeFetch.mock.calls[0] as [
      string,
      { signal?: unknown },
    ];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries 5xx with linear backoff and reports EXTERNAL when exhausted", async () => {
    safeFetch.mockResolvedValue(mockResponse(502, { message: "Bad gateway" }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

    expect(result).toEqual({
      success: false,
      error: "Bad gateway",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    // One attempt plus three retries, one second base delay by default.
    expect(safeFetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000, 3000]);
  });

  it("retries a connection refusal and succeeds on a later attempt", async () => {
    safeFetch
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(mockResponse(200, { id: "msg-1" }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result).toEqual({ success: true, messageId: "msg-1" });
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient 4xx", async () => {
    safeFetch.mockResolvedValue(
      mockResponse(400, {
        message: "Cannot send an empty message",
        code: 50_006,
      })
    );

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

    expect(result).toEqual({
      success: false,
      error: "Cannot send an empty message",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honours a retry count and delay set from the editor as strings", async () => {
    safeFetch.mockResolvedValue(mockResponse(503));

    const result = await runStep(WEBHOOK_URL, {
      retryAttempts: "1",
      retryDelay: "5",
    });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("sends exactly once by default, even on a 429", async () => {
    safeFetch.mockResolvedValue(mockResponse(429, { retry_after: 1 }));

    const result = await runStep(WEBHOOK_URL);

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range retry count to the maximum", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 99, retryDelay: 0 });

    // One attempt plus the maximum of five retries.
    expect(safeFetch).toHaveBeenCalledTimes(6);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("clamps the base retry delay to 15 seconds", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 1, retryDelay: 60 });

    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("keeps the backoff linear above the base delay cap", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 3, retryDelay: 15 });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      15_000, 30_000, 45_000,
    ]);
  });

  it.each([
    [
      "a reset after the request was sent",
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    ],
    [
      "a broken pipe",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    ],
    [
      "a request timeout",
      new DOMException("The operation was aborted", "TimeoutError"),
    ],
    ["an unclassified throw", new Error("boom")],
  ])(
    "does not retry %s, which may have reached Discord",
    async (_label, error) => {
      safeFetch.mockRejectedValue(error);

      const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

      expect(result.success).toBe(false);
      expect(result).toMatchObject({ errorClass: ExecutionErrorType.EXTERNAL });
      expect(safeFetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it("retries a DNS failure raised by safeFetch itself", async () => {
    safeFetch
      .mockRejectedValueOnce(new Error("Cannot resolve host: discord.com"))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result.success).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("never retries a blocked SSRF target and reports it as a user error", async () => {
    safeFetch.mockRejectedValue(
      new SsrfBlockedError("Blocked private address 10.0.0.1")
    );

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 5 });

    expect(result).toEqual({
      success: false,
      error:
        "Failed to send Discord message: URL is not allowed: Blocked private address 10.0.0.1",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logUserError).toHaveBeenCalledTimes(1);
    expect(logUserError.mock.calls[0]?.[1]).toBe(
      "[Discord] Blocked SSRF target"
    );
  });

  it("logs every failed attempt that is retried, even when the run recovers", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(502, { message: "Bad gateway" }))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, {
      retryAttempts: 3,
      retryDelay: 0,
    });

    expect(result.success).toBe(true);
    expect(logUserError).toHaveBeenCalledTimes(2);
    const [, message, error, labels] = logUserError.mock.calls[0] as [
      unknown,
      string,
      unknown,
      Record<string, string>,
    ];
    expect(message).toBe("[Discord] Attempt failed, retrying");
    expect(error).toEqual({ message: "Bad gateway" });
    expect(labels).toMatchObject({
      status: "502",
      attempt: "1",
      max_retries: "3",
    });
  });

  it("hands Discord's parsed error body, with its code, to the terminal log", async () => {
    safeFetch.mockResolvedValue(
      mockResponse(404, { message: "Unknown Webhook", code: 10_015 })
    );

    await runStep(WEBHOOK_URL);

    expect(logUserError).toHaveBeenCalledTimes(1);
    const [, message, error, labels] = logUserError.mock.calls[0] as [
      unknown,
      string,
      unknown,
      Record<string, string>,
    ];
    expect(message).toBe("[Discord] API error:");
    expect(error).toEqual({ message: "Unknown Webhook", code: 10_015 });
    expect(labels).toMatchObject({ status: "404", service: "discord" });
  });

  it.each([408, 425, 500, 503, 504])(
    "retries a %i like the HTTP node",
    async (status) => {
      safeFetch
        .mockResolvedValueOnce(mockResponse(status))
        .mockResolvedValueOnce(mockResponse(204));

      const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

      expect(result.success).toBe(true);
      expect(safeFetch).toHaveBeenCalledTimes(2);
    }
  );

  it.each([401, 403, 404, 501])("does not retry a %i", async (status) => {
    safeFetch.mockResolvedValue(mockResponse(status));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("makes exactly six requests at the maximum of five retries", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 5, retryDelay: 0 });

    expect(safeFetch).toHaveBeenCalledTimes(6);
  });

  it("treats a negative retry count as zero", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: -3 });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("truncates a fractional retry count from the editor", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: "2.9", retryDelay: 0 });

    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  it("falls back to the default when the retry count is junk", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: "lots" });

    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("honours a retry_after exactly at the cap without clamping", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, { retry_after: 15 }))
      .mockResolvedValueOnce(mockResponse(204));

    await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("abandons a retry_after just over the cap", async () => {
    safeFetch.mockResolvedValue(mockResponse(429, { retry_after: 15.001 }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries immediately without sleeping on a zero retry_after", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, { retry_after: 0 }))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result.success).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("ignores a negative retry_after and falls back to linear backoff", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, { retry_after: -1 }))
      .mockResolvedValueOnce(mockResponse(204));

    await runStep(WEBHOOK_URL, { retryAttempts: 1, retryDelay: 2 });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("ignores an HTTP-date Retry-After and falls back to linear backoff", async () => {
    safeFetch
      .mockResolvedValueOnce(
        mockResponse(
          429,
          {},
          { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }
        )
      )
      .mockResolvedValueOnce(mockResponse(204));

    await runStep(WEBHOOK_URL, { retryAttempts: 1, retryDelay: 2 });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("uses linear backoff for a 5xx even after a 429 in the same run", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, { retry_after: 0.5 }))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 2 });

    expect(result.success).toBe(true);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 2000]);
  });

  it("stops retrying once the count is exhausted even if the last error is retryable", async () => {
    safeFetch.mockResolvedValue(mockResponse(429, { retry_after: 0 }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 2 });

    expect(result).toEqual({
      success: false,
      error: "HTTP 429: Failed to send Discord message",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });
});
