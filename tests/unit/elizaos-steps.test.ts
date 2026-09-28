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

const { safeFetch, assertUrlIsPublic } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  assertUrlIsPublic,
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
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
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
    assertUrlIsPublic.mockReset();
    assertUrlIsPublic.mockResolvedValue();
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
      ELIZAOS_AGENT_ID: "123e4567-e89b-12d3-a456-426614174000",
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

  it("fails with USER error class when agentId is missing", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Agent ID is required");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("executes default v1 Sessions API two-step flow (session creation + message dispatch)", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_API_KEY: "secret-token",
      ELIZAOS_AGENT_ID: "123e4567-e89b-12d3-a456-426614174000",
    });

    // Mock call 1 (session creation) and call 2 (message dispatch)
    safeFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({ id: "session-uuid-999" })),
        json: () => Promise.resolve({ id: "session-uuid-999" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () =>
          Promise.resolve(
            JSON.stringify({ status: "success", txHash: "0x123abc" })
          ),
        json: () => Promise.resolve({ status: "success", txHash: "0x123abc" }),
      });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      payload: JSON.stringify({ minHealthFactor: 1.5 }),
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.response).toContain("0x123abc");
    }

    // Verified both URLs checked for SSRF
    expect(assertUrlIsPublic).toHaveBeenCalledWith(
      "https://agent.example.com/api/messaging/sessions"
    );
    expect(assertUrlIsPublic).toHaveBeenCalledWith(
      "https://agent.example.com/api/messaging/sessions/session-uuid-999/messages"
    );

    expect(safeFetch).toHaveBeenCalledTimes(2);

    // Call 1: POST /api/messaging/sessions
    const [url1, opt1] = safeFetch.mock.calls[0];
    expect(url1).toBe("https://agent.example.com/api/messaging/sessions");
    expect(opt1.method).toBe("POST");
    expect(opt1.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(opt1.body)).toEqual({
      agentId: "123e4567-e89b-12d3-a456-426614174000",
      userId: expect.any(String),
    });

    // Call 2: POST /api/messaging/sessions/{sessionId}/messages
    const [url2, opt2] = safeFetch.mock.calls[1];
    expect(url2).toBe(
      "https://agent.example.com/api/messaging/sessions/session-uuid-999/messages"
    );
    expect(opt2.method).toBe("POST");
    expect(opt2.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(opt2.body)).toEqual({
      content: {
        text: 'REBALANCE_DEFI: {"minHealthFactor":1.5}',
        action: "REBALANCE_DEFI",
        minHealthFactor: 1.5,
      },
    });
  });

  it("handles failure when creating v1 messaging session", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_AGENT_ID: "123e4567-e89b-12d3-a456-426614174000",
    });

    safeFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve(JSON.stringify({ error: "Agent not found" })),
      json: () => Promise.resolve({ error: "Agent not found" }),
    });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Agent not found");
      expect(result.errorClass).toBe(ExecutionErrorType.USER);
    }
  });

  it("handles failure when dispatching message to session", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_AGENT_ID: "123e4567-e89b-12d3-a456-426614174000",
    });

    safeFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({ id: "session-uuid-123" })),
        json: () => Promise.resolve({ id: "session-uuid-123" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(JSON.stringify({ error: "Runtime crash" })),
        json: () => Promise.resolve({ error: "Runtime crash" }),
      });

    const result = await executeAgentActionStep({
      action: "REBALANCE_DEFI",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Runtime crash");
      expect(result.errorClass).toBe(ExecutionErrorType.EXTERNAL);
    }
  });

  it("supports action-level agentId override", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_AGENT_ID: "cred-agent-uuid",
    });

    safeFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({ id: "session-override" })),
        json: () => Promise.resolve({ id: "session-override" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
        json: () => Promise.resolve("OK"),
      });

    const result = await executeAgentActionStep({
      action: "SCAN_RISK",
      agentId: "action-agent-uuid",
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(true);
    const [, opt1] = safeFetch.mock.calls[0];
    expect(JSON.parse(opt1.body).agentId).toBe("action-agent-uuid");
  });

  it("supports customizable path with all {agentId} tokens replaced and target body", async () => {
    mockFetchCredentials.mockResolvedValue({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
      ELIZAOS_AGENT_ID: "my-agent-uuid",
    });

    mockFetchOnce("OK");

    const result = await executeAgentActionStep({
      action: "SCAN_RISK",
      path: "/api/agents/{agentId}/plugins/{agentId}/action",
      payload: { mode: "safe" },
      integrationId: "int-1",
    } as any);

    expect(result.success).toBe(true);
    const [url, opt] = safeFetch.mock.calls[0];
    // Both occurrences of {agentId} replaced
    expect(url).toBe(
      "https://agent.example.com/api/agents/my-agent-uuid/plugins/my-agent-uuid/action"
    );
    expect(JSON.parse(opt.body)).toEqual({
      action: "SCAN_RISK",
      payload: { mode: "safe" },
    });
  });
});

describe("elizaos test connection", () => {
  // The connection test is bundled with the client-side plugin registry, so it
  // uses global fetch, not safeFetch. Its SSRF pre-flight lives server-side in
  // handlePluginTest, which validates endpointUrl before this runs.
  const globalFetch = vi.fn();

  beforeEach(() => {
    globalFetch.mockReset();
    vi.stubGlobal("fetch", globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails when ELIZAOS_ENDPOINT_URL is missing", async () => {
    const res = await testElizaOS({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("ELIZAOS_ENDPOINT_URL is required");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("returns success when endpoint responds 200 OK", async () => {
    globalFetch.mockResolvedValue({ ok: true, status: 200 } as never);

    const res = await testElizaOS({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com/",
      ELIZAOS_API_KEY: "secret",
    });

    expect(res.success).toBe(true);
    expect(globalFetch).toHaveBeenCalledWith(
      "https://agent.example.com/health",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret",
        },
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("returns error details when endpoint responds with 401 Unauthorized", async () => {
    globalFetch.mockResolvedValue({ ok: false, status: 401 } as never);

    const res = await testElizaOS({
      ELIZAOS_ENDPOINT_URL: "https://agent.example.com",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("HTTP 401");
  });
});
