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
import { getCredentialMapping, getIntegration } from "@/plugins/registry";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function htmlResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  };
}

const CONTEXT = {
  nodeId: "node-1",
  nodeName: "Check Credit",
  nodeType: "agent-gateway/check-credit",
  organizationId: "org-1",
};

function runStep() {
  return checkCreditStep({ integrationId: "int-1", _context: CONTEXT });
}

describe("agent-gateway check-credit step", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    mockFetchCredentials.mockReset();
    mockFetchCredentials.mockResolvedValue({
      AGENT_GATEWAY_SUB_ORG_ID: "su-1",
      AGENT_GATEWAY_HMAC_SECRET: "test-secret",
    });
  });

  it("refuses to call out when no integration is selected", async () => {
    const result = await checkCreditStep({ _context: CONTEXT });
    expect(result.success).toBe(false);
    expect(mockFetchCredentials).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses to call out when the connection holds only half the pair", async () => {
    mockFetchCredentials.mockResolvedValue({
      AGENT_GATEWAY_SUB_ORG_ID: "su-1",
    });

    const result = await runStep();

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("resolves credentials by integrationId and signs with them", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(200, { amount: "0.50", currency: "USD", subOrgId: "su-1" })
    );

    const result = await runStep();

    expect(result).toEqual({
      success: true,
      amount: "0.50",
      currency: "USD",
      subOrgId: "su-1",
    });

    expect(mockFetchCredentials).toHaveBeenCalledWith("int-1", {
      organizationId: "org-1",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      {
        plugin?: string;
        method?: string;
        headers?: Record<string, string>;
      },
    ];
    expect(url).toContain("/api/agentic-wallet/credit");
    expect(options.plugin).toBe("agent-gateway");
    expect(options.method).toBe("GET");
    expect(options.headers?.["X-KH-Sub-Org"]).toBe("su-1");
    expect(options.headers?.["X-KH-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(options.headers?.["X-KH-Timestamp"]).toMatch(/^\d+$/);
  });

  it("surfaces a non-2xx response as a failed result instead of throwing", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(404, { error: "Unknown sub-org", code: "WALLET_NOT_FOUND" })
    );

    const result = await runStep();

    expect(result).toEqual({
      success: false,
      error: "Unknown sub-org",
      code: "WALLET_NOT_FOUND",
    });
  });

  // An access proxy in front of a staging or PR environment answers 200 with
  // an HTML interstitial. Reporting that as a zero balance would let a
  // downstream Condition branch on a balance that was never read.
  it("fails a 200 whose body is not JSON", async () => {
    safeFetch.mockResolvedValue(htmlResponse(200));

    const result = await runStep();

    expect(result.success).toBe(false);
  });

  it("fails a 200 whose body is missing the balance fields", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await runStep();

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("/api/agentic-wallet/credit"),
    });
  });
});

// The executor builds step input without credentials, so a form field only
// reaches a step when it carries both configKey and envVar: that pair is what
// getCredentialMapping (Test Connection) and the generated
// PLUGIN_CREDENTIAL_MAP (fetchCredentials) copy. Without it both paths hand
// the step an empty object and every run fails on missing credentials.
describe("agent-gateway credential wiring", () => {
  it("maps the connection form's config keys onto the env-var keys the steps read", () => {
    const plugin = getIntegration("agent-gateway");
    expect(plugin).toBeDefined();

    if (!plugin) {
      return;
    }

    expect(
      getCredentialMapping(plugin, {
        subOrgId: "su-1",
        hmacSecret: "test-secret",
      })
    ).toEqual({
      AGENT_GATEWAY_SUB_ORG_ID: "su-1",
      AGENT_GATEWAY_HMAC_SECRET: "test-secret",
    });
  });
});
