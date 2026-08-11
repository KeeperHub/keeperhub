/**
 * Smoke test for GET /api/cron/security-behavioral-scan. The deep DB
 * integration belongs in a Postgres-backed test (parallel pattern to
 * other `tests/integration/*-sweeper.test.ts`); this file covers the
 * shape contract that the cron scheduler and the Loki alert depend on:
 *
 *   - 401 when the internal-service auth rejects (fails closed; no
 *     NODE_ENV bypass)
 *   - 200 + correct response body when the HMAC signature matches
 *   - Emits one structured `console.warn` per detected row
 *
 * Auth is delegated to `authenticateInternalService` (HMAC: X-KH-Caller +
 * X-KH-Timestamp + X-KH-Signature, signed with INTERNAL_SERVICE_HMAC_SECRET),
 * so it is mocked here the same way the reaper route test mocks it -- this
 * file asserts the route's handling of the auth verdict, not the verdict
 * logic itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalServiceAuthResult } from "@/lib/internal-service-auth";
import { rawConsole } from "@/lib/log/core";

// logSecurityEvent writes the structured line via lib/log/core's rawConsole.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

// authenticateInternalService is async and returns a discriminated union;
// reassigned per-test to drive the route's handling of each verdict.
let mockAuthResult: InternalServiceAuthResult = {
  authenticated: true,
  caller: "scheduler",
  scheme: "hmac",
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(() => Promise.resolve(mockAuthResult)),
}));

const { mockSelectChain, mockCaptureMessage } = vi.hoisted(() => ({
  mockSelectChain: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => mockSelectChain(),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "users.id", createdAt: "users.created_at" },
  workflowExecutions: {
    id: "we.id",
    userId: "we.user_id",
    workflowId: "we.workflow_id",
    startedAt: "we.started_at",
    triggerSource: "we.trigger_source",
    triggeredByCountry: "we.triggered_by_country",
  },
}));

const { GET } = await import("@/app/api/cron/security-behavioral-scan/route");

const warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
  // suppress test noise; we assert against the spy below
});
const errorSpy = vi.spyOn(raw, "error").mockImplementation(() => {
  // suppress test noise; we assert against the spy below
});

beforeEach(() => {
  warnSpy.mockClear();
  errorSpy.mockClear();
  mockSelectChain.mockReset();
  mockCaptureMessage.mockReset();
  mockAuthResult = {
    authenticated: true,
    caller: "scheduler",
    scheme: "hmac",
  };
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request(
    "http://localhost:3000/api/cron/security-behavioral-scan",
    {
      method: "GET",
      headers,
    }
  );
}

describe("security-behavioral-scan auth", () => {
  it("returns 401 when the internal-service auth rejects (fails closed)", async () => {
    // No NODE_ENV bypass: the route refuses whenever authenticateInternalService
    // does not authenticate, regardless of environment.
    mockAuthResult = { authenticated: false, error: "denied", status: 401 };
    const res = await GET(makeRequest({ "x-kh-caller": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a valid non-scheduler caller (least privilege)", async () => {
    // mcp/events/hub/executor keys satisfy authenticateInternalService but
    // must not be able to invoke the detection scan -- only the scheduler.
    mockAuthResult = {
      authenticated: true,
      caller: "mcp",
      scheme: "hmac",
    };
    const res = await GET(makeRequest({ "x-kh-caller": "mcp-key" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 for the scheduler caller", async () => {
    mockSelectChain.mockResolvedValueOnce([]);
    const res = await GET(makeRequest({ "x-kh-caller": "test-key" }));
    expect(res.status).toBe(200);
  });
});

describe("security-behavioral-scan response shape", () => {
  function authedRequest(): Request {
    // Top-level beforeEach already sets mockAuthResult.authenticated = true.
    return makeRequest({ "x-kh-caller": "test-key" });
  }

  it("returns 0 events when no rows match", async () => {
    mockSelectChain.mockResolvedValueOnce([]);
    const res = await GET(authedRequest());
    const body = (await res.json()) as {
      newAccountFirstWorkflowEvents: number;
      durationMs: number;
    };
    expect(body.newAccountFirstWorkflowEvents).toBe(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits one structured warn and one Sentry capture per matched row", async () => {
    const userCreatedAt = new Date("2026-05-26T10:00:00Z");
    const executionStartedAt = new Date("2026-05-26T10:00:42Z");
    mockSelectChain.mockResolvedValueOnce([
      {
        userId: "user_freshly_signed_up",
        workflowId: "wf_1",
        executionId: "exec_1",
        triggerSource: "manual",
        triggeredByCountry: "US",
        userCreatedAt,
        executionStartedAt,
      },
    ]);
    const res = await GET(authedRequest());
    const body = (await res.json()) as {
      newAccountFirstWorkflowEvents: number;
    };
    expect(body.newAccountFirstWorkflowEvents).toBe(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "security.behavioral.new_account_first_workflow",
      userId: "user_freshly_signed_up",
      workflowId: "wf_1",
      executionId: "exec_1",
      triggerSource: "manual",
      triggeredByCountry: "US",
      ageSecondsSinceSignup: 42,
    });

    // Dual-emit pattern: Sentry mirrors the stdout signal so triage gets
    // both transports for free. Asserts the tag / extra shape so an
    // accidental shape change doesn't silently break Sentry grouping, plus
    // the executionId fingerprint that collapses the overlapping-scan
    // duplicates into one Sentry issue.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      {
        level: string;
        fingerprint: string[];
        tags: Record<string, string>;
        user: { id: string };
        extra: Record<string, unknown>;
      },
    ];
    expect(message).toBe("security.behavioral.new_account_first_workflow");
    expect(options).toMatchObject({
      level: "warning",
      fingerprint: ["security.behavioral.new_account_first_workflow", "exec_1"],
      tags: {
        security: "behavioral.new_account_first_workflow",
        trigger_source: "manual",
      },
      user: { id: "user_freshly_signed_up" },
      extra: {
        workflowId: "wf_1",
        executionId: "exec_1",
        triggeredByCountry: "US",
        ageSecondsSinceSignup: 42,
      },
    });
  });

  it("survives a Sentry transport failure without dropping the stdout signal", async () => {
    mockCaptureMessage.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    mockSelectChain.mockResolvedValueOnce([
      {
        userId: "u_1",
        workflowId: "wf_1",
        executionId: "exec_1",
        triggerSource: "manual",
        triggeredByCountry: null,
        userCreatedAt: new Date("2026-05-26T10:00:00Z"),
        executionStartedAt: new Date("2026-05-26T10:00:30Z"),
      },
    ]);
    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    // Sentry threw but stdout still emitted -- the signal is durable.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("security-behavioral-scan self-failure signal", () => {
  function authedRequest(): Request {
    return makeRequest({ "x-kh-caller": "test-key" });
  }

  it("returns 500 and emits scan_error when the query throws", async () => {
    mockSelectChain.mockRejectedValueOnce(new Error("db unreachable"));
    const res = await GET(authedRequest());
    expect(res.status).toBe(500);

    // A broken scan must be observable as its own event: reaper.sh fails the
    // CronJob on the 500, but this specific signal says WHY detection went
    // dark instead of leaving only a generic job-failure alert.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "security.behavioral.scan_error",
      message: "db unreachable",
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "security.behavioral.scan_error",
      expect.objectContaining({
        level: "error",
        tags: { security: "behavioral.scan_error" },
      })
    );
  });

  it("still emits the stdout scan_error signal if Sentry throws", async () => {
    mockSelectChain.mockRejectedValueOnce(new Error("db unreachable"));
    mockCaptureMessage.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const res = await GET(authedRequest());
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
