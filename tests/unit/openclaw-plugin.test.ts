import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetchMock, assertUrlIsPublicMock, fetchCredentialsMock } =
  vi.hoisted(() => ({
    safeFetchMock: vi.fn(),
    assertUrlIsPublicMock: vi.fn(),
    fetchCredentialsMock: vi.fn(),
  }));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: safeFetchMock,
  assertUrlIsPublic: assertUrlIsPublicMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: fetchCredentialsMock,
}));

// The step wraps its handler in logging; the tests assert on the handler's
// result, so the wrapper is reduced to a pass-through.
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (
    _input: unknown,
    run: () => Promise<unknown>
  ): Promise<unknown> => run(),
}));

import { triggerAgentStep } from "@/plugins/openclaw/steps/trigger-agent";

const CREDS = {
  OPENCLAW_BASE_URL: "https://claw.example.com",
  OPENCLAW_HOOK_TOKEN: "hook-token",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callStep(overrides: Record<string, unknown> = {}) {
  return triggerAgentStep({
    message: "Summarise this run",
    integrationId: "integration-1",
    _context: { executionId: "exec-42", organizationId: "org-1" },
    ...overrides,
  } as never);
}

beforeEach(() => {
  safeFetchMock.mockReset();
  assertUrlIsPublicMock.mockReset();
  fetchCredentialsMock.mockReset();
  fetchCredentialsMock.mockResolvedValue(CREDS);
  assertUrlIsPublicMock.mockResolvedValue(undefined);
});

describe("configuration guards", () => {
  it("refuses to send when the base URL is missing", async () => {
    fetchCredentialsMock.mockResolvedValue({ OPENCLAW_HOOK_TOKEN: "t" });
    const result = await callStep();

    expect(result.success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error).toContain("OPENCLAW_BASE_URL");
      expect(result.errorClass).toBe("user");
    }
  });

  it("refuses to send when the hook token is missing", async () => {
    fetchCredentialsMock.mockResolvedValue({
      OPENCLAW_BASE_URL: "https://claw.example.com",
    });
    const result = await callStep();

    expect(result.success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error).toContain("OPENCLAW_HOOK_TOKEN");
    }
  });

  it("refuses an empty message", async () => {
    const result = await callStep({ message: "   " });

    expect(result.success).toBe(false);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

describe("request shape", () => {
  it("pins the path, the bearer token, deliver:false and isolated session mode", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-1" }));
    await callStep();

    expect(assertUrlIsPublicMock).toHaveBeenCalledWith(
      "https://claw.example.com/hooks/agent"
    );

    const [url, init] = safeFetchMock.mock.calls[0];
    expect(url).toBe("https://claw.example.com/hooks/agent");
    expect(init.method).toBe("POST");
    expect(init.plugin).toBe("openclaw");
    expect(init.headers.Authorization).toBe("Bearer hook-token");

    const body = JSON.parse(init.body);
    expect(body.message).toBe("Summarise this run");
    // deliver defaults to true upstream, so pinning false is the behaviour change.
    expect(body.deliver).toBe(false);
    expect(body.sessionMode).toBe("isolated");
    // v1 exposes no destination, so it cannot build a partial one.
    expect(body.channel).toBeUndefined();
    expect(body.to).toBeUndefined();
    expect(body.sessionKey).toBeUndefined();
  });

  it("derives the idempotency key from the execution id, as a header only", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-2" }));
    await callStep();

    const [, init] = safeFetchMock.mock.calls[0];
    expect(init.headers["Idempotency-Key"]).toBe("exec-42");
    expect(JSON.parse(init.body).idempotencyKey).toBeUndefined();
  });

  it("normalizes a base URL with a trailing slash", async () => {
    fetchCredentialsMock.mockResolvedValue({
      ...CREDS,
      OPENCLAW_BASE_URL: "https://claw.example.com/",
    });
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-3" }));
    await callStep();

    expect(safeFetchMock.mock.calls[0][0]).toBe(
      "https://claw.example.com/hooks/agent"
    );
  });

  it("passes optional fields through only when supplied", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-4" }));
    await callStep({
      agentId: "main",
      name: "treasury",
      timeoutSeconds: "90.7",
    });

    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.agentId).toBe("main");
    expect(body.name).toBe("treasury");
    // Direct payload values are floored to whole seconds upstream.
    expect(body.timeoutSeconds).toBe(90);
  });

  it("omits an invalid timeout instead of sending it", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-5" }));
    await callStep({ timeoutSeconds: "-5" });

    expect(
      JSON.parse(safeFetchMock.mock.calls[0][1].body).timeoutSeconds
    ).toBeUndefined();
  });
});

describe("admission receipts", () => {
  it("reports admission, not completion", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-9" }));
    const result = await callStep();

    expect(result).toEqual({ success: true, admitted: true, runId: "run-9" });
    // The word "complete" must not appear in a success payload: runId proves
    // admission only.
    expect(JSON.stringify(result)).not.toContain("complete");
  });

  it("rejects a 200 without a runId", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("admission");
    }
  });

  it("rejects ok:false even with a runId", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "nope", runId: "run-x" })
    );
    const result = await callStep();

    expect(result.success).toBe(false);
  });

  it("rejects a 200 that is not JSON", async () => {
    safeFetchMock.mockResolvedValue(
      new Response("<html>proxy</html>", { status: 200 })
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("external");
    }
  });
});

describe("status mapping", () => {
  it("treats a rejected token as the author's problem", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "unauthorized" }, 401)
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("OPENCLAW_HOOK_TOKEN");
      expect(result.errorClass).toBe("user");
    }
  });

  it("treats a session refusal as a user error and says retrying will not help", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "session busy" }, 409)
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("user");
      expect(result.error).toContain("409");
    }
  });

  it("surfaces a 503 as an external failure and refuses to retry it", async () => {
    safeFetchMock.mockResolvedValue(
      new Response("gateway_unavailable", { status: 503 })
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    if (!result.success) {
      expect(result.errorClass).toBe("external");
      // The 503 is the status that tempts a retry into a duplicate turn.
      expect(result.error).toContain("does not retry");
    }
  });

  it("maps an unexpected 5xx to external", async () => {
    safeFetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("external");
    }
  });

  it("bounds upstream error text", async () => {
    safeFetchMock.mockResolvedValue(
      new Response("x".repeat(5000), { status: 500 })
    );
    const result = await callStep();

    if (!result.success) {
      expect(result.error.length).toBeLessThan(700);
      expect(result.error).toContain("500");
    }
  });

  it("never echoes the hook token", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "bad token hook-token rejected" }, 401)
    );
    const result = await callStep();

    // The instance's own text is passed through bounded; our token is only
    // ever placed in the header, never in an error string we build.
    if (!result.success) {
      expect(result.error).not.toContain("Bearer hook-token");
    }
  });

  it("surfaces a transport failure without throwing", async () => {
    safeFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ECONNREFUSED");
      expect(result.errorClass).toBe("external");
    }
  });
});
