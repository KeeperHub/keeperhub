import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
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
// pre-check) and stub only the network call. The internal-IP cases below
// throw inside assertUrlIsPublic before safeFetch is ever reached.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { getAddressInfoStep } from "@/plugins/blockscout/steps/get-address-info";

describe("blockscout SSRF guard", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The instance URL is user-controlled via the connection's
  // BLOCKSCOUT_API_URL, so an attacker-configured internal host must be
  // rejected before any outbound request.
  const blockedInstances = [
    "http://169.254.169.254",
    "http://127.0.0.1",
    "http://[::1]",
    "http://10.0.0.5",
    "http://192.168.1.1",
  ];

  for (const instanceUrl of blockedInstances) {
    it(`rejects internal instance URL ${instanceUrl} without calling safeFetch`, async () => {
      mockFetchCredentials.mockResolvedValue({
        BLOCKSCOUT_API_URL: instanceUrl,
      });

      const result = await getAddressInfoStep({
        address: "0xabc",
        integrationId: "int-1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed");
      }
      // The SSRF pre-check fires before any outbound request.
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-http(s) instance scheme before fetching", async () => {
    mockFetchCredentials.mockResolvedValue({
      BLOCKSCOUT_API_URL: "file:///etc/passwd",
    });

    const result = await getAddressInfoStep({
      address: "0xabc",
      integrationId: "int-1",
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("allows a public instance URL and routes it through safeFetch", async () => {
    // 93.184.216.34 (example.com) is a public address; the IP-literal path in
    // assertUrlIsPublic resolves synchronously without DNS, so this stays
    // deterministic and offline.
    mockFetchCredentials.mockResolvedValue({
      BLOCKSCOUT_API_URL: "http://93.184.216.34",
    });
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ hash: "0xabc" }),
    });

    const result = await getAddressInfoStep({
      address: "0xabc",
      integrationId: "int-1",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
