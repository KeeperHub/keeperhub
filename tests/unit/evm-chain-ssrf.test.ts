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

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  logUserError: vi.fn(),
}));

// Keep the real assertUrlIsPublic + SsrfBlockedError (the load-bearing SSRF
// pre-check) and stub only the network call. The internal-IP cases below
// throw inside assertUrlIsPublic before safeFetch is ever reached.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { ethBalanceStep } from "@/plugins/evm-chain/steps/eth-balance";

const ADDRESS = `0x${"a".repeat(40)}`;

describe("evm-chain SSRF guard", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The RPC URL is user input, so an attacker-supplied internal host must be
  // rejected before any outbound request.
  const blockedUrls = [
    "http://169.254.169.254",
    "http://127.0.0.1",
    "http://[::1]",
    "http://10.0.0.5",
    "http://192.168.1.1",
  ];

  for (const rpcUrl of blockedUrls) {
    it(`rejects internal RPC URL ${rpcUrl} without calling safeFetch`, async () => {
      mockFetchCredentials.mockResolvedValue({
        EVM_CHAIN_RPC_URL: rpcUrl,
      });

      const result = await ethBalanceStep({
        address: ADDRESS,
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

  it("rejects a non-http(s) RPC scheme before fetching", async () => {
    mockFetchCredentials.mockResolvedValue({
      EVM_CHAIN_RPC_URL: "file:///etc/passwd",
    });

    const result = await ethBalanceStep({
      address: ADDRESS,
      integrationId: "int-1",
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("allows a public RPC URL and routes it through safeFetch", async () => {
    // 93.184.216.34 (example.com) is a public address; the IP-literal path in
    // assertUrlIsPublic resolves synchronously without DNS, so this stays
    // deterministic and offline.
    mockFetchCredentials.mockResolvedValue({
      EVM_CHAIN_RPC_URL: "http://93.184.216.34",
    });
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0x1" }),
    });

    const result = await ethBalanceStep({
      address: ADDRESS,
      integrationId: "int-1",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balanceWei).toBe("0x1");
      expect(result.balanceNative).toBe("0.000000000000000001");
    }
  });
});
