import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// safe-fetch reaches for @sentry/nextjs and the metrics collector at module
// load, and the real @/lib/logging module pulls both in too. Same stubs, for
// the same reason, as tests/unit/blockscout-ssrf.test.ts:21-29.
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

const {
  safeFetchMock,
  assertUrlIsPublicMock,
  fetchCredentialsMock,
  ssrfBlockedErrorMock,
  logUserErrorMock,
} = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  assertUrlIsPublicMock: vi.fn(),
  fetchCredentialsMock: vi.fn(),
  // Matches the real constructor in lib/safe-fetch.ts:35-53. A double whose
  // constructor takes a string would make `message` "[object Object]", and the
  // user-facing text for a blocked target is the whole point of that path.
  ssrfBlockedErrorMock: class SsrfBlockedError extends Error {
    readonly code = "SSRF_BLOCKED";
    readonly hostname: string;
    readonly resolvedIp?: string;
    readonly reason: string;

    constructor(params: {
      hostname: string;
      resolvedIp?: string;
      reason: string;
      message: string;
    }) {
      super(params.message);
      this.name = "SsrfBlockedError";
      this.hostname = params.hostname;
      this.resolvedIp = params.resolvedIp;
      this.reason = params.reason;
    }
  },
  logUserErrorMock: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: safeFetchMock,
  assertUrlIsPublic: assertUrlIsPublicMock,
  SsrfBlockedError: ssrfBlockedErrorMock,
}));

vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: fetchCredentialsMock,
}));

// Required mock (plugins/CLAUDE.md:140-143). Without it the real module runs,
// and nothing can observe the classification this file's URL tests assert.
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: logUserErrorMock,
}));

// The step wraps its handler in metrics and logging; the tests assert on the
// handler's result, so both wrappers are reduced to pass-throughs.
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  runPluginStep: (
    _options: unknown,
    _input: unknown,
    run: () => Promise<unknown>
  ): Promise<unknown> => run(),
  withStepLogging: (
    _input: unknown,
    run: () => Promise<unknown>
  ): Promise<unknown> => run(),
}));

import { SsrfBlockedError } from "@/lib/safe-fetch";
import { triggerAgentStep } from "@/plugins/openclaw/steps/trigger-agent";
import { testOpenClawConnection } from "@/plugins/openclaw/test";

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
    _context: {
      executionId: "exec-42",
      nodeId: "node-7",
      organizationId: "org-1",
    },
    ...overrides,
  } as never);
}

function lastInit() {
  return safeFetchMock.mock.calls[0][1];
}

beforeEach(() => {
  safeFetchMock.mockReset();
  assertUrlIsPublicMock.mockReset();
  fetchCredentialsMock.mockReset();
  logUserErrorMock.mockReset();
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

  it("sends nothing when the node has no integration attached", async () => {
    const result = await callStep({ integrationId: undefined });

    // No integration means no credentials to read, and nothing to send with.
    expect(fetchCredentialsMock).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("user");
    }
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

  it("bounds the request itself, not only the response text", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-t" }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let timeoutMs: unknown;
    try {
      await callStep();
      // Read the argument before restoring: mockRestore() clears the recorded
      // calls along with the implementation.
      timeoutMs = timeout.mock.calls[0]?.[0];
    } finally {
      timeout.mockRestore();
    }

    // A hung instance must not hold the step open indefinitely. OpenClaw
    // answers 503 for its own 15-second admission window, so the client
    // timeout has to sit above that, hence an AbortSignal rather than a race.
    // The value is the load-bearing part: at or below 15000 the client aborts
    // mid-admission and the mapped 503 never gets a chance to arrive.
    expect(lastInit().signal).toBeInstanceOf(AbortSignal);
    expect(typeof timeoutMs).toBe("number");
    expect(timeoutMs as number).toBeGreaterThan(15_000);
  });

  it("derives the idempotency key from the execution id, as a header only", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-2" }));
    await callStep();

    expect(lastInit().headers["Idempotency-Key"]).toBe("exec-42:node-7");
    expect(JSON.parse(lastInit().body).idempotencyKey).toBeUndefined();
  });

  it("gives each node in one run its own replay key", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-n" }));

    await callStep();
    const first = lastInit().headers["Idempotency-Key"];

    safeFetchMock.mockClear();
    await callStep({ _context: { executionId: "exec-42", nodeId: "node-8" } });
    const second = lastInit().headers["Idempotency-Key"];

    // Same run, two Trigger Agent nodes: identical keys would make OpenClaw
    // replay the second node's turn as the first node's admission.
    expect(first).not.toBe(second);
    expect(second).toContain("node-8");
  });

  it("gives each loop iteration its own replay key", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-i" }));

    await callStep({
      _context: {
        executionId: "exec-42",
        nodeId: "node-7",
        forEachNodeId: "loop-1",
        iterationIndex: 0,
      },
    });
    const first = lastInit().headers["Idempotency-Key"];

    safeFetchMock.mockClear();
    await callStep({
      _context: {
        executionId: "exec-42",
        nodeId: "node-7",
        forEachNodeId: "loop-1",
        iterationIndex: 1,
      },
    });
    const second = lastInit().headers["Idempotency-Key"];

    expect(first).not.toBe(second);
  });

  it("omits the replay key when the run has no execution id", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-0" }));
    await callStep({ _context: { nodeId: "node-7" } });

    expect(lastInit().headers["Idempotency-Key"]).toBeUndefined();
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

    const body = JSON.parse(lastInit().body);
    expect(body.agentId).toBe("main");
    expect(body.name).toBe("treasury");
    // Direct payload values are floored to whole seconds upstream.
    expect(body.timeoutSeconds).toBe(90);
  });

  it("omits an invalid timeout instead of sending it", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: "run-5" }));
    await callStep({ timeoutSeconds: "-5" });

    expect(JSON.parse(lastInit().body).timeoutSeconds).toBeUndefined();
  });
});

describe("URL validation", () => {
  it("classifies a blocked internal target as the author's mistake", async () => {
    assertUrlIsPublicMock.mockRejectedValue(
      new SsrfBlockedError({
        hostname: "10.0.0.5",
        reason: "private-ip",
        message: 'safe-fetch: hostname "10.0.0.5" is not public',
      })
    );
    const result = await callStep();

    // The author chose that URL, so the run must not blame a third party for
    // it: the house pattern classifies this as a user error and logs it as one.
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("user");
      expect(result.error).toContain("not allowed");
      // The blocked host has to reach the author. With a double whose
      // constructor takes a string this assertion fails, which is the point.
      expect(result.error).toContain("10.0.0.5");
    }
    // The classification fix is the change under test, so assert on what it
    // emits rather than on the branch that happens to run.
    expect(logUserErrorMock).toHaveBeenCalledTimes(1);
    const [category, message, error, context] = logUserErrorMock.mock.calls[0];
    expect(category).toBe("validation");
    expect(message).toBe("[OpenClaw] Blocked SSRF target");
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect(context).toEqual({
      plugin_name: "openclaw",
      action_name: "trigger-agent",
    });
  });

  it("classifies an unparseable instance URL as the author's mistake", async () => {
    assertUrlIsPublicMock.mockRejectedValue(new TypeError("Invalid URL"));
    const result = await callStep();

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe("user");
      expect(result.error).toContain("could not be validated");
    }
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

  it.each([
    [400, "user"],
    [404, "user"],
    [405, "user"],
    [413, "user"],
    [429, "external"],
  ])("maps %i to %s", async (status, errorClass) => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "refused" }, status as number)
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorClass).toBe(errorClass);
      expect(result.error).toContain(String(status));
    }
  });

  it("does not describe a 429 as an authentication failure", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: "slow down" }, 429)
    );
    const result = await callStep();

    // The instance rate-limits requests; nothing here proves the token was
    // throttled, and the token is never what the action reports on.
    if (!result.success) {
      expect(result.error.toLowerCase()).not.toContain("authentication");
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

  it("caps the body it reads before parsing or redacting it", async () => {
    // The host is the author's, so the body size is not ours to trust. The
    // slice happens before the parse, which is observable: a JSON document
    // this long cannot parse once truncated, so the raw head is what the
    // author sees, and the result still lands inside the 400-character bound.
    const huge = `{"error": "${"x".repeat(9000)}"}`;
    safeFetchMock.mockResolvedValue(
      new Response(huge, {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('{"error"');
      expect(result.error).not.toContain("x".repeat(500));
      expect(result.error.length).toBeLessThan(700);
    }
  });

  it("never echoes the hook token when the instance sends it back", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, error: "rejected Authorization: Bearer hook-token" },
        401
      )
    );
    const result = await callStep();

    // An instance or a proxy in front of one can echo request headers into its
    // error body, and that body is written into the run log.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("hook-token");
      expect(result.error).toContain("[redacted]");
    }
  });

  it("redacts a token that straddles the length bound", async () => {
    // The bound used to run first. It cuts at 400 characters, so a token
    // crossing that cut was truncated before the redaction pass could match
    // it and its prefix survived into the run log.
    safeFetchMock.mockResolvedValue(
      jsonResponse({ error: `${"a".repeat(395)}hook-token` }, 500)
    );
    const result = await callStep();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("hook");
    }
  });

  it("redacts a bearer token it was not configured with", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, error: "upstream key Bearer sk-live-9 was used" },
        401
      )
    );
    const result = await callStep();

    if (!result.success) {
      expect(result.error).not.toContain("sk-live-9");
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

describe("step conventions", () => {
  it("keeps the step non-retrying", () => {
    // A side-effecting POST must not be retried by the executor: a retry can
    // admit a second turn.
    expect(triggerAgentStep.maxRetries).toBe(0);
  });
});

describe("test connection", () => {
  it("reports a missing base URL", async () => {
    const result = await testOpenClawConnection({
      OPENCLAW_HOOK_TOKEN: "hook-token",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("OPENCLAW_BASE_URL");
    }
  });

  it("reports a missing hook token", async () => {
    const result = await testOpenClawConnection({
      OPENCLAW_BASE_URL: "https://claw.example.com",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("OPENCLAW_HOOK_TOKEN");
    }
  });

  it("rejects a non-http scheme", async () => {
    const result = await testOpenClawConnection({
      OPENCLAW_BASE_URL: "ftp://claw.example.com",
      OPENCLAW_HOOK_TOKEN: "hook-token",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("http");
    }
  });

  it("rejects a URL that does not parse", async () => {
    const result = await testOpenClawConnection({
      OPENCLAW_BASE_URL: "claw.example.com",
      OPENCLAW_HOOK_TOKEN: "hook-token",
    });

    expect(result.status).toBe("error");
  });

  it("accepts a complete instance configuration without calling it", async () => {
    const result = await testOpenClawConnection({
      OPENCLAW_BASE_URL: "https://claw.example.com",
      OPENCLAW_HOOK_TOKEN: "hook-token",
    });

    // This check validates configuration only: probing /hooks/agent with a
    // real call would admit an agent turn and spend a model run.
    expect(result).toEqual({ status: "success" });
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(assertUrlIsPublicMock).not.toHaveBeenCalled();
  });
});
