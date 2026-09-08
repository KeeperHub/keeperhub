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
// pre-check) and stub only the network call. The internal-IP cases below
// throw inside assertUrlIsPublic before safeFetch is ever reached.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { sendWebhookStep } from "@/plugins/webhook/steps/send-webhook";

const baseInput = {
  webhookMethod: "POST",
  webhookHeaders: undefined,
  webhookPayload: JSON.stringify({ hello: "world" }),
};

describe("sendWebhookStep SSRF guard", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const blockedUrls = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1/internal",
    "http://[::1]/internal",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/",
  ];

  for (const webhookUrl of blockedUrls) {
    it(`rejects internal/metadata target ${webhookUrl} without calling safeFetch`, async () => {
      const result = await sendWebhookStep({ ...baseInput, webhookUrl });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed");
      }
      // The SSRF pre-check fires before any outbound request.
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-http(s) scheme before fetching", async () => {
    const result = await sendWebhookStep({
      ...baseInput,
      webhookUrl: "file:///etc/passwd",
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

    const result = await sendWebhookStep({
      ...baseInput,
      webhookUrl: "http://93.184.216.34/hook",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.statusCode).toBe(200);
    }
  });
});
