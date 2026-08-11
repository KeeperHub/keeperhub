import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";

const {
  mockGetSession,
  mockUsersFindFirst,
  mockAuthorizeAction,
  txUpdateCalls,
  txDeleteCalls,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockAuthorizeAction: vi.fn(),
  txUpdateCalls: [] as Array<{ table: unknown; value: unknown }>,
  txDeleteCalls: [] as Array<{ table: unknown }>,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction: mockAuthorizeAction,
}));

// A `.where()` result that is awaitable (for the users update, which awaits it
// directly) AND exposes `.returning()` (for the sessions delete and org-keys
// update, which read back the rows they touched for the audit cascade).
function whereWithReturning() {
  return Object.assign(Promise.resolve(undefined), {
    returning: vi.fn().mockResolvedValue([]),
  });
}

// Track every tx.update / tx.delete call in order so the test asserts on
// what the route actually did, not on the identity of internal mock tokens
// for each schema table. This is sturdier than routing-by-table-string and
// catches unexpected extra writes.
const txStub = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    }),
  }),
  update: vi.fn((table: unknown) => ({
    set: vi.fn((value: unknown) => {
      txUpdateCalls.push({ table, value });
      return { where: vi.fn(whereWithReturning) };
    }),
  })),
  delete: vi.fn((table: unknown) => {
    txDeleteCalls.push({ table });
    return { where: vi.fn(whereWithReturning) };
  }),
};

vi.mock("@/lib/db", () => ({
  db: {
    query: { users: { findFirst: mockUsersFindFirst } },
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => {
      await cb(txStub);
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id" },
  sessions: { userId: "user_id" },
  organizationApiKeys: {
    id: "id",
    createdBy: "created_by",
    revokedAt: "revoked_at",
  },
  walletAddress: { userId: "user_id" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH" },
  logSystemError: vi.fn(),
}));

// Keep the real actor/correlation builders the route uses; no-op the audit
// writers so this test stays focused on the cascade's DB writes. The schema
// mock above intentionally omits securityAuditLog, so the writers must not run.
vi.mock("@/lib/security/audit-log", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/security/audit-log")>();
  return { ...actual, recordAuditEvent: vi.fn(), recordAuditEvents: vi.fn() };
});

import { POST } from "@/app/api/user/delete/route";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txUpdateCalls.length = 0;
  txDeleteCalls.length = 0;
  mockAuthorizeAction.mockResolvedValue({ ok: true });
});

describe("POST /api/user/delete", () => {
  it("performs three writes inside a transaction: users update, sessions delete, org-keys revoke", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      isAnonymous: false,
      deactivatedAt: null,
    });

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(200);

    // Two updates: users (deactivatedAt) then organizationApiKeys (revokedAt).
    expect(txUpdateCalls).toHaveLength(2);

    const usersUpdate = txUpdateCalls[0].value as {
      deactivatedAt: Date;
      updatedAt: Date;
    };
    expect(usersUpdate.deactivatedAt).toBeInstanceOf(Date);
    expect(usersUpdate.updatedAt).toBeInstanceOf(Date);

    const orgKeysUpdate = txUpdateCalls[1].value as { revokedAt: Date };
    expect(orgKeysUpdate.revokedAt).toBeInstanceOf(Date);

    // One delete: sessions.
    expect(txDeleteCalls).toHaveLength(1);
  });

  it("rejects when confirmation is missing without entering the transaction", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });

    const response = await POST(buildRequest({ confirmation: "wrong" }));

    expect(response.status).toBe(400);
    expect(txUpdateCalls).toHaveLength(0);
    expect(txDeleteCalls).toHaveLength(0);
  });

  it("rejects when account is already deactivated without entering the transaction", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      isAnonymous: false,
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(400);
    expect(txUpdateCalls).toHaveLength(0);
    expect(txDeleteCalls).toHaveLength(0);
  });

  it("rejects unauthenticated callers without entering the transaction", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(401);
    expect(txUpdateCalls).toHaveLength(0);
    expect(txDeleteCalls).toHaveLength(0);
  });
});
