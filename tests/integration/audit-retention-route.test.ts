/**
 * Contract test for GET /api/cron/audit-retention. Reachable through the same
 * HMAC wrapper (deploy/scripts/reaper.sh) as the other cron routes, so
 * authenticateInternalService is mocked the same way the reaper route test
 * mocks it; this file asserts the route's handling of the verdict, not the
 * verdict logic.
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

const { mockPurge, mockLogSystemError } = vi.hoisted(() => ({
  mockPurge: vi.fn(),
  mockLogSystemError: vi.fn(),
}));

vi.mock("@/lib/security/audit-retention", () => ({
  AUDIT_RETENTION_DAYS: 730,
  purgeExpiredAuditEvents: mockPurge,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: mockLogSystemError,
}));

import { GET } from "@/app/api/cron/audit-retention/route";
import { authenticateInternalService } from "@/lib/internal-service-auth";

function createRequest(): Request {
  return new Request("http://localhost:3000/api/cron/audit-retention", {
    headers: { "X-KH-Caller": "scheduler" },
  });
}

describe("/api/cron/audit-retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPurge.mockResolvedValue(0);
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
      error: "Invalid signature",
      status: 401,
    };

    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("no longer accepts a CRON_SECRET bearer token", async () => {
    process.env.CRON_SECRET = "legacy-cron-secret";
    mockAuthResult = {
      authenticated: false,
      error: "Missing auth headers",
      status: 401,
    };

    const response = await GET(
      new Request("http://localhost:3000/api/cron/audit-retention", {
        headers: { authorization: "Bearer legacy-cron-secret" },
      })
    );

    expect(response.status).toBe(401);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("purges as of now and reports the count and window", async () => {
    mockPurge.mockResolvedValue(12);

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 12, retentionDays: 730 });
    expect(mockPurge).toHaveBeenCalledWith(expect.any(Date));
  });

  it("returns 500 and logs when the purge throws", async () => {
    mockPurge.mockRejectedValue(new Error("deadlock detected"));

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "purge failed" });
    expect(mockLogSystemError).toHaveBeenCalledWith(
      "database",
      "Failed to purge expired audit events",
      expect.any(Error),
      { endpoint: "/api/cron/audit-retention" }
    );
  });
});
