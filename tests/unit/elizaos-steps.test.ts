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
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { executeAgentActionStep } from "@/plugins/elizaos/steps/execute-agent-action";
import { testElizaOS } from "@/plugins/elizaos/test";

function mockFetchOnce(
  body: unknown,
  init?: { ok?: boolean; status?: number; isJson?: boolean }
) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const isJson = init?.isJson ?? true;
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () =>
      isJson
        ? Promise.resolve(body)
        : Promise.reject(new Error("Unexpected token < in JSON at position 0")),
  });
}

describe("elizaos execute-agent-action step", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  it("fails with USER error class when ELIZAOS_ENDPOINT_URL is missing", async () => {
    mockFetchCredentials.mockResolvedValue({});

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ELIZAOS_ENDPOINT_URL is not configured");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("fails with USER error class when action is missing", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    const result = await executeAgentActionStep({
      action: "",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Action name is required");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("fails with USER error class on malformed JSON payload", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      payload: "{invalid_json: true",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid JSON in payload");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("successfully dispatches action with 200 JSON response", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_API_KEY: "secret-token",
      ELIZAOS_AGENT_ID: "agent-default",
    });

    mockFetchOnce({ status: "success", txHash: "0x123abc" });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      payload: JSON.stringify({ minHealthFactor: 1.5 }),
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.response).toContain("0x123abc");
    }

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0];
    expect(url).toBe(
      "https://agent.example.com/api/agents/agent-default/action"
    );
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer secret-token");
    expect(options.plugin).toBe("elizaos");
    expect(JSON.parse(options.body)).toEqual({
      action: "REBALANCE_DEFI",
      payload: { minHealthFactor: 1.5 },
    });
  });

  it("supports action-level agentId override", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_AGENT_ID: "agent-default",
    });

    mockFetchOnce({ ok: true });

    const result = await executeAgentActionStep({
      action: "SCAN_RISK",
      agentId: "custom-agent-99",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(true);
    const [url] = safeFetch.mock.calls[0];
    expect(url).toBe(
      "https://agent.example.com/api/agents/custom-agent-99/action"
    );
  });

  it("handles non-2xx response with error payload", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    mockFetchOnce(
      { error: "Agent execution rejected by safety policy" },
      { ok: false, status: 400 }
    );

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Agent execution rejected by safety policy");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("handles non-JSON error response from upstream proxy (e.g. 502 Bad Gateway)", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    mockFetchOnce("<html>Bad Gateway</html>", {
      ok: false,
      status: 502,
      isJson: false,
    });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("HTTP 502: ElizaOS agent action failed");
      expect(result.errorClass).toBe(ExecutionErrorType.EXTERNAL);
    }
  });
});

describe("elizaos test connection", () => {
  it("fails when ELIZAOS_ENDPOINT_URL is missing", async () => {
    const res = await testElizaOS({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("ELIZAOS_ENDPOINT_URL is required");
  });

  it("returns success when endpoint responds 200 OK", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as any);

    try {
      const res = await testElizaOS({
        ELIZAOS_ENDPOINT_URL: "https://agent.example.com/",
        ELIZAOS_API_KEY: "secret",
      });

      expect(res.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://agent.example.com/health",
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer secret",
          },
        }
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns error details when endpoint responds with 401 Unauthorized", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as any);

    try {
      const res = await testElizaOS({
        ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("HTTP 401");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
