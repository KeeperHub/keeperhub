/**
 * End-to-end auth check for the two cron routes this change migrated off
 * `CRON_SECRET`: the signature is verified by the REAL
 * authenticateInternalService, not a stand-in for it.
 *
 * The per-route contract tests (execution-reconciler-route, audit-retention-route)
 * mock the auth module, so they pin how a route handles a verdict but cannot
 * show that a legacy `Authorization: Bearer $CRON_SECRET` request is now
 * rejected by the verifier itself. Only the secret store and the loggers are
 * stubbed here; the signing string comes from the shared test signer, which
 * mirrors deploy/scripts/reaper.sh.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInternalServiceHeaders } from "../utils/internal-service-auth";

vi.mock("server-only", () => ({}));

const SECRET = "test-internal-service-hmac-secret";

const { mockReconcile, mockPurge, mockLogInternalAuthEvent } = vi.hoisted(
  () => ({
    mockReconcile: vi.fn(),
    mockPurge: vi.fn(),
    mockLogInternalAuthEvent: vi.fn(),
  })
);

vi.mock("@/lib/internal-service-hmac-store", () => ({
  listActiveHmacSecrets: vi.fn(() =>
    Promise.resolve([{ secret: SECRET, keyVersion: 1 }])
  ),
  lookupHmacSecret: vi.fn(() =>
    Promise.resolve({ secret: SECRET, keyVersion: 1 })
  ),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
  logInternalAuthEvent: mockLogInternalAuthEvent,
}));

vi.mock("@/lib/execute/reconcile-executions", () => ({
  reconcileUnconfirmedExecutions: mockReconcile,
}));

vi.mock("@/lib/security/audit-retention", () => ({
  AUDIT_RETENTION_DAYS: 730,
  purgeExpiredAuditEvents: mockPurge,
}));

import { GET as auditRetentionGet } from "@/app/api/cron/audit-retention/route";
import { GET as reconcilerGet } from "@/app/api/cron/execution-reconciler/route";

const EMPTY_SUMMARY = {
  examined: 0,
  completed: 0,
  failed: 0,
  stillUnconfirmed: 0,
  deferred: 0,
};

const ROUTES = [
  {
    name: "/api/cron/execution-reconciler",
    url: "http://localhost:3000/api/cron/execution-reconciler",
    handler: reconcilerGet,
    handlerMock: mockReconcile,
  },
  {
    name: "/api/cron/audit-retention",
    url: "http://localhost:3000/api/cron/audit-retention",
    handler: auditRetentionGet,
    handlerMock: mockPurge,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockReconcile.mockResolvedValue({
    direct: EMPTY_SUMMARY,
    workflows: EMPTY_SUMMARY,
  });
  mockPurge.mockResolvedValue(0);
  delete process.env.CRON_SECRET;
});

describe.each(ROUTES)("$name internal-service HMAC", (route) => {
  it("accepts a request signed the way reaper.sh signs it", async () => {
    const response = await route.handler(
      new Request(route.url, {
        headers: signInternalServiceHeaders({
          method: "GET",
          url: route.url,
          caller: "scheduler",
          secret: SECRET,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(route.handlerMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a CRON_SECRET bearer token", async () => {
    process.env.CRON_SECRET = "legacy-cron-secret";

    const response = await route.handler(
      new Request(route.url, {
        headers: { authorization: "Bearer legacy-cron-secret" },
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing auth headers" });
    expect(route.handlerMock).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const response = await route.handler(
      new Request(route.url, {
        headers: signInternalServiceHeaders({
          method: "GET",
          url: route.url,
          caller: "scheduler",
          secret: "not-the-shared-secret",
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(route.handlerMock).not.toHaveBeenCalled();
  });

  it("rejects a signature made for the other cron route's path", async () => {
    const other = ROUTES.find((candidate) => candidate.url !== route.url);
    if (!other) {
      throw new Error("expected a second route to borrow a signature from");
    }

    const response = await route.handler(
      new Request(route.url, {
        headers: signInternalServiceHeaders({
          method: "GET",
          url: other.url,
          caller: "scheduler",
          secret: SECRET,
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(route.handlerMock).not.toHaveBeenCalled();
  });
});
