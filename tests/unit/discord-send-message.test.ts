import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

// Discord egress routes through safeFetch (the SSRF guard). Mock it so the
// test asserts on what URL/options the step hands to it, without real network.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { sendDiscordMessageStep } from "@/plugins/discord/steps/send-message";

function runStep(webhookUrl: string) {
  mockFetchCredentials.mockResolvedValue({ webhookUrl });
  return sendDiscordMessageStep({
    integrationId: "int-1",
    discordMessage: "hello",
  });
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
