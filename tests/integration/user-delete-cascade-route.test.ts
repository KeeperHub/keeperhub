import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordAuditEventArgs } from "@/lib/security/audit-log";

vi.mock("server-only", () => ({}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));

const mockAuthorizeAction = vi.fn();
vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction: (...args: unknown[]) => mockAuthorizeAction(...args),
}));

// Identifiable schema table references so the tx mock can branch on which
// table an update targets (users vs organizationApiKeys). Defined via
// vi.hoisted so they exist when the hoisted vi.mock factory runs.
const { usersTable, sessionsTable, orgApiKeysTable } = vi.hoisted(() => ({
  usersTable: { __table: "users" },
  sessionsTable: { __table: "sessions" },
  orgApiKeysTable: { __table: "organization_api_keys" },
}));
vi.mock("@/lib/db/schema", () => ({
  users: usersTable,
  sessions: sessionsTable,
  organizationApiKeys: orgApiKeysTable,
  securityAuditLog: { __table: "security_audit_log" },
  walletAddress: { userId: "user_id" },
}));

const mockFindFirst = vi.fn();
const mockTransaction = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    query: { users: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
    transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

// Keep the real actor/correlation/metadata builders; spy on the writers so we
// can assert exactly what cascade the route emits.
const mockRecordAuditEvent = vi.fn();
const mockRecordAuditEvents = vi.fn();
vi.mock("@/lib/security/audit-log", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/security/audit-log")>();
  return {
    ...actual,
    recordAuditEvent: (...a: unknown[]) => mockRecordAuditEvent(...a),
    recordAuditEvents: (...a: unknown[]) => mockRecordAuditEvents(...a),
  };
});

import { POST } from "@/app/api/user/delete/route";

function deactivateRequest(): Request {
  return new Request("http://localhost/api/user/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      confirmation: "DEACTIVATE",
      code: "123456",
      emailOtp: "654321",
    }),
  });
}

/** A tx whose delete/update return canned cascade rows via `.returning()`. */
function makeTx() {
  const sessionsReturning = vi
    .fn()
    .mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
  const keysReturning = vi
    .fn()
    .mockResolvedValue([{ id: "k1", organizationId: "o1" }]);
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      }),
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn(() => ({
        where:
          table === orgApiKeysTable
            ? vi.fn(() => ({ returning: keysReturning }))
            : vi.fn().mockResolvedValue(undefined),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: sessionsReturning })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: "usr_1", email: "user@test.com", isAnonymous: false },
  });
  mockFindFirst.mockResolvedValue({
    id: "usr_1",
    isAnonymous: false,
    deactivatedAt: null,
  });
  mockAuthorizeAction.mockResolvedValue({ ok: true });
});

describe("POST /api/user/delete cascade audit", () => {
  it("records the whole cascade under one correlation id", async () => {
    mockTransaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(makeTx())
    );

    const response = await POST(deactivateRequest());
    expect(response.status).toBe(200);

    expect(mockRecordAuditEvents).toHaveBeenCalledTimes(1);
    const [events, executor] = mockRecordAuditEvents.mock.calls[0] as [
      RecordAuditEventArgs[],
      unknown,
    ];
    // root + session summary + one row per revoked key.
    expect(events.map((e) => e.action)).toEqual([
      "account.deactivated",
      "session.revoked",
      "org_api_key.revoked",
    ]);
    // All share one correlation id.
    const ids = new Set(events.map((e) => e.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    // Durable attribution snapshot survives a later user-row purge.
    expect(events[0].actor.actorLabel).toBe("user@test.com");
    // Key event is org-scoped and points at the revoked key.
    const keyEvent = events.find((e) => e.action === "org_api_key.revoked");
    expect(keyEvent?.resourceId).toBe("k1");
    expect(keyEvent?.actor.organizationId).toBe("o1");
    // Written through the transaction (atomic), not the global db.
    expect(executor).toBeDefined();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it("records a durable failed marker when the cascade rolls back", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("boom"));

    const response = await POST(deactivateRequest());
    expect(response.status).toBe(500);

    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    const failed = mockRecordAuditEvent.mock
      .calls[0][0] as RecordAuditEventArgs;
    expect(failed.outcome).toBe("failed");
    expect(failed.action).toBe("account.deactivated");
    expect(failed.correlationId).toBeTruthy();
    // The failure marker is best-effort: no executor, so it uses the global db.
    expect(failed.executor).toBeUndefined();
  });
});
