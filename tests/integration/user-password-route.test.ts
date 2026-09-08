import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const USER_EMAIL = "user@example.com";
const CURRENT_SESSION_ID = "session-current";
const CREDENTIAL_ACCOUNT_ID = "acct-credential";

const {
  mockGetSession,
  mockRequireDualFactor,
  mockVerifyPassword,
  mockHashPassword,
  mockAnd,
  mockEq,
  mockNe,
  selectResult,
  updateCalls,
  deleteCalls,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRequireDualFactor: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockHashPassword: vi.fn(),
  mockAnd: vi.fn((...args: unknown[]) => ({ __and: args })),
  mockEq: vi.fn((column: unknown, value: unknown) => ({
    __eq: [column, value],
  })),
  mockNe: vi.fn((column: unknown, value: unknown) => ({
    __ne: [column, value],
  })),
  selectResult: { current: [] as unknown[] },
  updateCalls: [] as Array<{ table: unknown; value: unknown }>,
  deleteCalls: [] as Array<{ table: unknown }>,
}));

vi.mock("drizzle-orm", () => ({
  and: mockAnd,
  eq: mockEq,
  ne: mockNe,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/mfa/dual-factor", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/mfa/dual-factor")>()),
  requireDualFactor: mockRequireDualFactor,
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: mockVerifyPassword,
  hashPassword: mockHashPassword,
}));

vi.mock("@/lib/db", () => {
  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectResult.current)),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        updateCalls.push({ table, value });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      deleteCalls.push({ table });
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
    // The password change wraps its update + session-delete in a
    // transaction; run the callback with the same mocked builder so the
    // update/delete call trackers still observe the writes.
    transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(dbMock)),
  };
  return { db: dbMock };
});

vi.mock("@/lib/db/schema", () => ({
  accounts: {
    id: "accounts.id",
    userId: "accounts.userId",
    providerId: "accounts.providerId",
    password: "accounts.password",
  },
  sessions: { id: "sessions.id", userId: "sessions.userId" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/user/password/route";
import { sessions as sessionsToken } from "@/lib/db/schema";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildSession() {
  mockGetSession.mockResolvedValue({
    user: { id: USER_ID, email: USER_EMAIL },
    session: { id: CURRENT_SESSION_ID },
  });
}

function credentialAccountRows(): unknown[] {
  return [
    {
      id: CREDENTIAL_ACCOUNT_ID,
      providerId: "credential",
      password: "stored-hash",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResult.current = [];
  updateCalls.length = 0;
  deleteCalls.length = 0;
  mockRequireDualFactor.mockResolvedValue({ ok: true });
  mockVerifyPassword.mockResolvedValue(true);
  mockHashPassword.mockResolvedValue("new-stored-hash");
});

describe("POST /api/user/password", () => {
  it("revokes every session except the current one on success", async () => {
    buildSession();
    selectResult.current = credentialAccountRows();

    const response = await POST(
      buildRequest({
        currentPassword: "old-password",
        newPassword: "new-password-1",
        code: "111111",
        emailOtp: "222222",
      })
    );

    expect(response.status).toBe(200);

    // Exactly one delete, against the sessions table.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe(sessionsToken);

    // Scoped to this user, excluding the caller's current session.
    expect(mockEq).toHaveBeenCalledWith("sessions.userId", USER_ID);
    expect(mockNe).toHaveBeenCalledWith("sessions.id", CURRENT_SESSION_ID);
  });

  it("does not delete sessions when the current password is wrong", async () => {
    buildSession();
    selectResult.current = credentialAccountRows();
    mockVerifyPassword.mockResolvedValue(false);

    const response = await POST(
      buildRequest({
        currentPassword: "wrong-password",
        newPassword: "new-password-1",
      })
    );

    expect(response.status).toBe(401);
    expect(deleteCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("does not delete sessions when the dual-factor challenge fails", async () => {
    buildSession();
    selectResult.current = credentialAccountRows();
    mockRequireDualFactor.mockResolvedValue({
      ok: false,
      error: "Two-factor required",
      code: "mfa_required",
      status: 401,
    });

    const response = await POST(
      buildRequest({
        currentPassword: "old-password",
        newPassword: "new-password-1",
      })
    );

    expect(response.status).toBe(401);
    expect(deleteCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });
});
