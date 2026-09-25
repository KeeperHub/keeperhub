import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { checkCreditStep } from "@/plugins/agent-gateway/steps/check-credit";
import { signPaymentStep } from "@/plugins/agent-gateway/steps/sign-payment";
import { testAgentGateway } from "@/plugins/agent-gateway/test";

function redirectResponse(status: number, location: string) {
  return {
    ok: false,
    status,
    headers: new Headers({ Location: location }),
    json: () => Promise.reject(new SyntaxError("Redirect body is not JSON")),
  };
}

const CONTEXT = {
  nodeId: "node-test",
  nodeName: "Test Node",
  nodeType: "agent-gateway/test",
  organizationId: "org-test",
};

const PAYMENT_INPUT = {
  integrationId: "int-1",
  _context: CONTEXT,
  chain: "base" as const,
  workflowSlug: "secure-workflow",
  paymentChallenge: { payTo: "0xabc", amount: "1000", nonce: "0x99" },
};

describe("agent-gateway redirect containment & fail-closed security", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    mockFetchCredentials.mockReset();
    mockFetchCredentials.mockResolvedValue({
      AGENT_GATEWAY_SUB_ORG_ID: "su-123",
      AGENT_GATEWAY_HMAC_SECRET: "hmac-secret-xyz",
    });
  });

  it("handles 301 Moved Permanently safely without leaking payment challenges", async () => {
    safeFetch.mockResolvedValue(
      redirectResponse(301, "https://external-host.com/sink")
    );

    const result = await signPaymentStep(PAYMENT_INPUT);

    expect(result).toEqual({
      success: false,
      status: "error",
      error: "Request failed with status 301",
      code: undefined,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      { redirect?: string; method?: string },
    ];
    expect(url).toContain("/api/agentic-wallet/sign");
    expect(options.redirect).toBe("manual");
  });

  it("handles 307 Temporary Redirect fail-closed without replaying POST body", async () => {
    safeFetch.mockResolvedValue(
      redirectResponse(307, "https://open-redirect.example.org/capture")
    );

    const result = await signPaymentStep(PAYMENT_INPUT);

    expect(result).toEqual({
      success: false,
      status: "error",
      error: "Request failed with status 307",
      code: undefined,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [, options] = safeFetch.mock.calls[0] as [
      string,
      { redirect?: string },
    ];
    expect(options.redirect).toBe("manual");
  });

  it("fails closed on 302 Found during check-credit balance query", async () => {
    safeFetch.mockResolvedValue(
      redirectResponse(302, "https://login.cloudflareaccess.com/auth")
    );

    const result = await checkCreditStep({
      integrationId: "int-1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: "Request failed with status 302",
      code: undefined,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      { redirect?: string; method?: string },
    ];
    expect(url).toContain("/api/agentic-wallet/credit");
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("manual");
  });

  it("fails closed on 308 Permanent Redirect during check-credit", async () => {
    safeFetch.mockResolvedValue(
      redirectResponse(308, "https://alternate-host.com/api/v2")
    );

    const result = await checkCreditStep({
      integrationId: "int-1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: "Request failed with status 308",
      code: undefined,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [, options] = safeFetch.mock.calls[0] as [
      string,
      { redirect?: string },
    ];
    expect(options.redirect).toBe("manual");
  });

  it("enforces manual redirect policy during connection test to prevent header leakage", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ Location: "https://evil.sink/leak" }),
      json: () => Promise.reject(new Error("unexpected redirect body")),
    } as unknown as Response);

    const result = await testAgentGateway({
      AGENT_GATEWAY_SUB_ORG_ID: "su-123",
      AGENT_GATEWAY_HMAC_SECRET: "hmac-secret-xyz",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection failed: HTTP 302");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(options.redirect).toBe("manual");
    fetchSpy.mockRestore();
  });
});

