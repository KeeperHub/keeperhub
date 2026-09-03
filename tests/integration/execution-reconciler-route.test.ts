/**
 * Contract test for GET /api/cron/execution-reconciler. The route is the only
 * thing that settles `unconfirmed` executions, and it is reached by the
 * `execution-reconciler` CronJob through deploy/scripts/reaper.sh, which signs
 * with the internal-service HMAC scheme. This file asserts the route's handling
 * of the auth verdict and of the reconciler's result, not the verdict logic
 * itself (covered by tests/unit/internal-service-auth.test.ts), so
 * authenticateInternalService is mocked the same way the reaper route test
 * mocks it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalServiceAuthResult } from "@/lib/internal-service-auth";

let mockAuthResult: InternalServiceAuthResult = {
  authenticated: true,
  caller: "scheduler",
  scheme: "hmac",
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(() => Promise.resolve(mockAuthResult)),
}));

const { mockReconcile, mockLogSystemError } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockLogSystemError: vi.fn(),
}));

vi.mock("@/lib/execute/reconcile-executions", () => ({
  reconcileUnconfirmedExecutions: mockReconcile,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

import { GET } from "@/app/api/cron/execution-reconciler/route";
import { authenticateInternalService } from "@/lib/internal-service-auth";

const EMPTY_SUMMARY = {
  examined: 0,
  completed: 0,
  failed: 0,
  stillUnconfirmed: 0,
  deferred: 0,
};

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/cron/execution-reconciler", {
    headers: { "X-KH-Caller": "scheduler", ...headers },
  });
}

describe("/api/cron/execution-reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockResolvedValue({
      direct: EMPTY_SUMMARY,
      workflows: EMPTY_SUMMARY,
    });
    mockAuthResult = {
      authenticated: true,
      caller: "scheduler",
      scheme: "hmac",
    };
    delete process.env.CRON_SECRET;
  });

  it("passes the request to authenticateInternalService", async () => {
    const request = createRequest();
    await GET(request);

    expect(authenticateInternalService).toHaveBeenCalledWith(request);
  });

  it("returns the auth verdict's status and error when rejected", async () => {
    mockAuthResult = {
      authenticated: false,
      error: "Timestamp outside replay window",
      status: 401,
    };

    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Timestamp outside replay window",
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("no longer accepts a CRON_SECRET bearer token", async () => {
    process.env.CRON_SECRET = "legacy-cron-secret";
    mockAuthResult = {
      authenticated: false,
      error: "Missing auth headers",
      status: 401,
    };

    const response = await GET(
      new Request("http://localhost:3000/api/cron/execution-reconciler", {
        headers: { authorization: "Bearer legacy-cron-secret" },
      })
    );

    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns the reconcile report on success", async () => {
    const report = {
      direct: { ...EMPTY_SUMMARY, examined: 2, completed: 1, failed: 1 },
      workflows: { ...EMPTY_SUMMARY, examined: 1, stillUnconfirmed: 1 },
    };
    mockReconcile.mockResolvedValue(report);

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and logs when reconciliation throws", async () => {
    mockReconcile.mockRejectedValue(new Error("connection refused"));

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "reconcile failed" });
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "Failed to reconcile unconfirmed executions",
      expect.any(Error),
      { endpoint: "/api/cron/execution-reconciler" }
    );
  });
});
