import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
// pre-check) and stub only the network call. The internal-IP cases below
// throw inside assertUrlIsPublic before safeFetch is ever reached.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { httpRequest } from "@/lib/workflow/nodes/http-request/perform";

describe("httpRequest SSRF guard", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const blockedEndpoints = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1/internal",
    "http://[::1]/internal",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/",
  ];

  for (const endpoint of blockedEndpoints) {
    it(`rejects internal/metadata target ${endpoint} without calling safeFetch`, async () => {
      const result = await httpRequest({ endpoint });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("URL is not allowed");
      }
      // The SSRF pre-check fires before any outbound request.
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-http(s) scheme before fetching", async () => {
    const result = await httpRequest({ endpoint: "file:///etc/passwd" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("URL is not allowed");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("hard-fails an internal target even when failOnError is false", async () => {
    // SSRF blocks must never be soft-failed into a `{ success: true }` miss --
    // an aggregator workflow should not silently swallow a request aimed at an
    // internal/metadata address.
    const result = await httpRequest({
      endpoint: "http://169.254.169.254/latest/meta-data/",
      failOnError: false,
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("hard-fails a malformed URL even when failOnError is false", async () => {
    // A malformed endpoint is a config error, not a transient miss: it must
    // not soft-fail into a `{ success: true }` result an aggregator swallows.
    const result = await httpRequest({
      endpoint: "http://",
      failOnError: false,
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("allows a public IP-literal target and routes it through safeFetch", async () => {
    // 93.184.216.34 (example.com) is a public address; the IP-literal path in
    // assertUrlIsPublic resolves synchronously without DNS, so this stays
    // deterministic and offline.
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ received: true }),
    });

    const result = await httpRequest({
      endpoint: "http://93.184.216.34/data",
      httpMethod: "GET",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ received: true });
    }
  });
});
