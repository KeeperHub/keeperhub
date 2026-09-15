/**
 * Contract test for GET /api/internal/retention/devkit. Reached through the
 * same HMAC wrapper (deploy/scripts/reaper.sh) as the other scheduled routes,
 * so authenticateInternalService is mocked the way the other retention route
 * test mocks it. This asserts the route's handling of the job result, not the
 * job itself.
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

const { mockRunDevkitRetentionPurge, mockLogSystemError } = vi.hoisted(() => ({
  mockRunDevkitRetentionPurge: vi.fn(),
  mockLogSystemError: vi.fn(),
}));

vi.mock("@/lib/retention/purge-devkit-runs", () => ({
  runDevkitRetentionPurge: mockRunDevkitRetentionPurge,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

import { GET } from "@/app/api/internal/retention/devkit/route";
import { authenticateInternalService } from "@/lib/internal-service-auth";

function createRequest(): Request {
  return new Request("http://localhost:3000/api/internal/retention/devkit", {
    headers: { "X-KH-Caller": "scheduler" },
  });
}

const RESULT = {
  enabled: true,
  dryRun: false,
  retentionDays: 30,
  durationMs: 850,
  runs: 500,
  steps: 2000,
  events: 7500,
  budgetExhausted: false,
};

describe("/api/internal/retention/devkit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunDevkitRetentionPurge.mockResolvedValue(RESULT);
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
    expect(mockRunDevkitRetentionPurge).not.toHaveBeenCalled();
  });

  it("returns the job result", async () => {
    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
  });

  it("returns 500 and logs when the job throws", async () => {
    mockRunDevkitRetentionPurge.mockRejectedValue(
      new Error("canceling statement due to statement timeout")
    );

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "canceling statement due to statement timeout",
    });
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "[DevKit Retention] Failed to purge expired DevKit runs",
      expect.any(Error),
      { endpoint: "/api/internal/retention/devkit", operation: "get" }
    );
  });
});
