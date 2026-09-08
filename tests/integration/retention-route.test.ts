/**
 * Contract test for GET /api/internal/retention. Reached through the same HMAC
 * wrapper (deploy/scripts/reaper.sh) as the other scheduled routes, so
 * authenticateInternalService is mocked the way the reaper and audit-retention
 * route tests mock it. This asserts the route's handling of the purge result --
 * including which metrics it is allowed to emit -- not the purge logic itself.
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

const {
  mockRunRetentionPurge,
  mockRecordRows,
  mockRecordRun,
  mockRecordWindow,
  mockLogSystemError,
} = vi.hoisted(() => ({
  mockRunRetentionPurge: vi.fn(),
  mockRecordRows: vi.fn(),
  mockRecordRun: vi.fn(),
  mockRecordWindow: vi.fn(),
  mockLogSystemError: vi.fn(),
}));

vi.mock("@/lib/retention/purge-executions", () => ({
  runRetentionPurge: mockRunRetentionPurge,
}));

vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordRetentionRowsPurged: mockRecordRows,
  recordRetentionRun: mockRecordRun,
  recordRetentionWindow: mockRecordWindow,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

import { GET } from "@/app/api/internal/retention/route";
import { authenticateInternalService } from "@/lib/internal-service-auth";

function createRequest(): Request {
  return new Request("http://localhost:3000/api/internal/retention", {
    headers: { "X-KH-Caller": "scheduler" },
  });
}

function purgeResult(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    executionsEnabled: false,
    dryRun: false,
    durationMs: 1200,
    floorDays: 365,
    passes: [
      { pass: "logs_floor", rows: 0, budgetExhausted: false },
      {
        pass: "logs_plan_window",
        rows: 4200,
        budgetExhausted: false,
        windows: [
          { retentionDays: 7, organizationCount: 975, rows: 4000 },
          { retentionDays: 30, organizationCount: 9, rows: 200 },
        ],
      },
      {
        pass: "executions_flat_window",
        rows: 0,
        budgetExhausted: false,
        skipped: "disabled",
      },
    ],
    totalRows: 4200,
    ...overrides,
  };
}

describe("/api/internal/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunRetentionPurge.mockResolvedValue(purgeResult());
    mockAuthResult = {
      authenticated: true,
      caller: "scheduler",
      scheme: "hmac",
    };
  });

  it("passes the request to authenticateInternalService", async () => {
    const request = createRequest();
    await GET(request);

    expect(authenticateInternalService).toHaveBeenCalledWith(request);
  });

  it("returns the auth verdict's status and error when rejected", async () => {
    mockAuthResult = {
      authenticated: false,
      error: "Invalid signature",
      status: 401,
    };

    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(mockRunRetentionPurge).not.toHaveBeenCalled();
  });

  it("reports the per-pass result and counts the rows of each pass", async () => {
    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(purgeResult());
    expect(mockRecordRows).toHaveBeenCalledWith("logs_floor", 0);
    expect(mockRecordRows).toHaveBeenCalledWith("logs_plan_window", 4200);
    expect(mockRecordRun).toHaveBeenCalledWith("success");
  });

  it("reports the organizations resolved onto each window", async () => {
    // This is what makes a run auditable: most organizations have no
    // subscription row and fall back to the default window, and nothing read
    // logRetentionDays before this job, so a wrong value could sit unnoticed.
    await GET(createRequest());

    expect(mockRecordWindow).toHaveBeenCalledWith(7, 975, 4000);
    expect(mockRecordWindow).toHaveBeenCalledWith(30, 9, 200);
  });

  it("does not move the counters on a dry run, whose rows were never deleted", async () => {
    mockRunRetentionPurge.mockResolvedValue(purgeResult({ dryRun: true }));

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(mockRecordRows).not.toHaveBeenCalled();
    expect(mockRecordWindow).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it("does not move the counters while the job is switched off", async () => {
    mockRunRetentionPurge.mockResolvedValue({
      enabled: false,
      executionsEnabled: false,
      dryRun: false,
      durationMs: 0,
      floorDays: 400,
      passes: [],
      totalRows: 0,
    });

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it("returns 500, counts the failure and logs when the purge throws", async () => {
    mockRunRetentionPurge.mockRejectedValue(new Error("deadlock detected"));

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "deadlock detected" });
    expect(mockRecordRun).toHaveBeenCalledWith("failure");
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "Failed to purge expired execution data",
      expect.any(Error),
      { endpoint: "/api/internal/retention", operation: "get" }
    );
  });
});
