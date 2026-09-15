import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    CONFIGURATION: "configuration",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

// safe-fetch pulls in @sentry/nextjs and the metrics collector at module
// load. Stub both so the real SSRF guard (assertUrlIsPublic / isBlockedIp)
// runs without dragging in heavyweight deps.
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

// Keep the real assertUrlIsPublic + SsrfBlockedError (the load-bearing SSRF
// pre-check) and stub only the network call.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { fetchPaidResourceStep } from "@/plugins/x402/steps/fetch-paid-resource";

// Public IP-literal target so the real SSRF guard resolves synchronously
// without DNS; stays deterministic and offline.
const PUBLIC_URL = "http://93.184.216.34/yields";

const QUOTE_402 = {
  x402Version: 2,
  error: "payment required: retry with X-PAYMENT header",
  resource: {
    url: "https://api.example.com/yields",
    description: "DeFi data snapshot",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xce81d12cce65bba50b017857a98526b021004b97",
      amount: "10000",
      maxAmountRequired: "10000",
      maxTimeoutSeconds: 300,
    },
  ],
};

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

describe("fetchPaidResourceStep", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing URL", async () => {
    const result = await fetchPaidResourceStep({ resourceUrl: "" });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL", async () => {
    const result = await fetchPaidResourceStep({ resourceUrl: "not-a-url" });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects an internal target without calling safeFetch", async () => {
    const result = await fetchPaidResourceStep({
      resourceUrl: "http://127.0.0.1/yields",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not allowed");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("passes a free (200) response through unpaid", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { count: 20 }));

    const result = await fetchPaidResourceStep({ resourceUrl: PUBLIC_URL });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      paid: false,
      statusCode: 200,
      data: { count: 20 },
      priceUsdc: null,
    });
  });

  it("surfaces non-402 errors as HTTP failures", async () => {
    safeFetch.mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const result = await fetchPaidResourceStep({ resourceUrl: PUBLIC_URL });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("HTTP 500");
    }
  });

  it("returns the payment quote without retrying when no signature is set", async () => {
    safeFetch.mockResolvedValue(jsonResponse(402, QUOTE_402));

    const result = await fetchPaidResourceStep({ resourceUrl: PUBLIC_URL });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.paymentRequired).toBe(true);
      expect(result.priceUsdc).toBe("0.01");
      expect(result.paymentQuote).toMatchObject({
        scheme: "exact",
        network: "eip155:8453",
        payTo: "0xce81d12cce65bba50b017857a98526b021004b97",
        amountAtomic: "10000",
        priceUsdc: "0.01",
      });
    }
  });

  it("retries with X-PAYMENT headers when a signature is provided", async () => {
    safeFetch
      .mockResolvedValueOnce(jsonResponse(402, QUOTE_402))
      .mockResolvedValueOnce(jsonResponse(200, { count: 20 }));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      paymentSignature: "c2lnbmF0dXJl",
    });

    expect(safeFetch).toHaveBeenCalledTimes(2);
    const retryOptions = safeFetch.mock.calls[1]?.[1] as
      | Record<string, unknown>
      | undefined;
    const retryHeaders = retryOptions?.headers as Record<string, string>;
    expect(retryHeaders["X-PAYMENT"]).toBe("c2lnbmF0dXJl");
    expect(retryHeaders["PAYMENT-SIGNATURE"]).toBe("c2lnbmF0dXJl");
    expect(result).toEqual({
      success: true,
      paid: true,
      statusCode: 200,
      data: { count: 20 },
      priceUsdc: "0.01",
    });
  });

  it("refuses to pay above maxPriceUsdc and returns the quote", async () => {
    safeFetch.mockResolvedValue(jsonResponse(402, QUOTE_402));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      maxPriceUsdc: "0.005",
      paymentSignature: "c2lnbmF0dXJl",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exceeds maxPriceUsdc");
      expect(result.paymentRequired).toBe(true);
    }
  });

  it("rejects an invalid maxPriceUsdc", async () => {
    safeFetch.mockResolvedValue(jsonResponse(402, QUOTE_402));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      maxPriceUsdc: "free",
    });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("selects the requirement matching the network filter", async () => {
    const multi = {
      ...QUOTE_402,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:1",
          asset: "0xA0b8100000000000000000000000000000000000",
          payTo: "0x1111111111111111111111111111111111111111",
          amount: "5000",
        },
        QUOTE_402.accepts[0],
      ],
    };
    safeFetch.mockResolvedValue(jsonResponse(402, multi));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      network: "base",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.paymentQuote).toMatchObject({ network: "eip155:8453" });
      expect(result.priceUsdc).toBe("0.01");
    }
  });

  it("errors when no requirement matches the network filter", async () => {
    safeFetch.mockResolvedValue(jsonResponse(402, QUOTE_402));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      network: "eip155:137",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("eip155:137");
    }
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("errors on a 402 with no usable requirements", async () => {
    safeFetch.mockResolvedValue(jsonResponse(402, { error: "pay up" }));

    const result = await fetchPaidResourceStep({ resourceUrl: PUBLIC_URL });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("without x402 payment requirements");
    }
  });

  it("reports a rejected payment without losing the quote", async () => {
    safeFetch
      .mockResolvedValueOnce(jsonResponse(402, QUOTE_402))
      .mockResolvedValueOnce(jsonResponse(402, QUOTE_402));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      paymentSignature: "c3RhbGU=",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("rejected");
      expect(result.paymentRequired).toBe(true);
      expect(result.paymentQuote).toMatchObject({ priceUsdc: "0.01" });
    }
  });

  it("passes an abort signal on both the probe and the paid retry", async () => {
    safeFetch
      .mockResolvedValueOnce(jsonResponse(402, QUOTE_402))
      .mockResolvedValueOnce(jsonResponse(200, { count: 20 }));

    const result = await fetchPaidResourceStep({
      resourceUrl: PUBLIC_URL,
      paymentSignature: "c2lnbmF0dXJl",
    });

    expect(result.success).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    for (const call of safeFetch.mock.calls) {
      const options = call[1] as Record<string, unknown> | undefined;
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
