import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const USER_EMAIL = "user@techops.services";

const {
  mockResolveCaller,
  mockVerifyTOTP,
  mockGetSession,
  mockHashSessionToken,
  updateCalls,
  selectRows,
} = vi.hoisted(() => ({
  mockResolveCaller: vi.fn(),
  mockVerifyTOTP: vi.fn(),
  mockGetSession: vi.fn(),
  mockHashSessionToken: vi.fn((token: string) => `hashed:${token}`),
  updateCalls: [] as Array<{
    table: unknown;
    value: unknown;
    where: { column: unknown; value: unknown };
  }>,
  // Rows returned by the read-after-write assert on users.two_factor_enabled.
  selectRows: [{ twoFactorEnabled: true }] as Array<{
    twoFactorEnabled: boolean;
  }>,
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock("@/lib/enroll-mfa-caller", () => ({
  resolveEnrollMfaCaller: mockResolveCaller,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { verifyTOTP: mockVerifyTOTP, getSession: mockGetSession } },
}));

vi.mock("@/lib/auth-session-token-hash", () => ({
  hashSessionToken: mockHashSessionToken,
  signSessionCookieValue: vi.fn(() => "signed-cookie-value"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn((where: { column: unknown; value: unknown }) => {
          updateCalls.push({ table, value, where });
          return Promise.resolve(undefined);
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(selectRows)),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  sessions: {
    id: "sessions.id",
    token: "sessions.token",
    userId: "sessions.userId",
  },
  twoFactor: {
    userId: "twoFactor.userId",
    secret: "twoFactor.secret",
    backupCodes: "twoFactor.backupCodes",
  },
  users: { id: "users.id", twoFactorEnabled: "users.twoFactorEnabled" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH", CONFIGURATION: "CONFIGURATION" },
  logSystemError: vi.fn(),
}));

// Not exercised by the session path, but imported at module load.
vi.mock("@/lib/pending-signup-cookie", () => ({
  buildPendingSignupClearCookie: vi.fn(() => "pending-clear"),
}));
vi.mock("@/lib/security/device-trust", () => ({
  resolveSigninDevice: vi.fn(async () => null),
}));
vi.mock("@/lib/security/login-risk", () => ({
  recordTrustedCountryFromRequest: vi.fn(async () => undefined),
  resolveClientIpFromHeaders: vi.fn(() => null),
}));
vi.mock("@/lib/security/totp-verify", () => ({
  verifyUserTotp: vi.fn(async () => true),
}));
vi.mock("@/lib/mfa/dual-factor-rate-limit", () => ({
  checkDualFactorRateLimit: vi.fn(() => ({ allowed: true })),
  resetDualFactor: vi.fn(),
}));

import { POST } from "@/app/api/user/totp/enroll/route";

function buildRequest(): Request {
  return new Request("http://localhost/api/user/totp/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
}

function headersWithSessionCookie(cookie: string): Headers {
  const headers = new Headers();
  headers.append("set-cookie", cookie);
  return headers;
}

function isSessionsUpdate(call: { where: { column: unknown } }): boolean {
  return (
    call.where.column === "sessions.token" ||
    call.where.column === "sessions.id" ||
    call.where.column === "sessions.userId"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  selectRows.length = 0;
  selectRows.push({ twoFactorEnabled: true });
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-1234567890";
  mockResolveCaller.mockResolvedValue({
    kind: "session",
    userId: USER_ID,
    email: USER_EMAIL,
  });
});

describe("POST /api/user/totp/enroll (session path requires_mfa scope)", () => {
  it("clears requires_mfa scoped to the rotated session token, not every session of the user", async () => {
    mockVerifyTOTP.mockResolvedValue({
      headers: headersWithSessionCookie(
        "better-auth.session_token=rawtok123.sigABC; Path=/; HttpOnly"
      ),
    });

    const response = await POST(buildRequest());

    expect(response.status).toBe(200);

    const sessionUpdates = updateCalls.filter(isSessionsUpdate);
    // Exactly one session update, and it targets the token hash.
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].where.column).toBe("sessions.token");
    expect(sessionUpdates[0].where.value).toBe("hashed:rawtok123");

    // The broad where(userId) clear must never run.
    const broadClears = updateCalls.filter(
      (call) => call.where.column === "sessions.userId"
    );
    expect(broadClears).toHaveLength(0);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("falls back to the caller's current session id when no rotated cookie is present", async () => {
    mockVerifyTOTP.mockResolvedValue({ headers: new Headers() });
    mockGetSession.mockResolvedValue({ session: { id: "sess-xyz" } });

    const response = await POST(buildRequest());

    expect(response.status).toBe(200);

    const sessionUpdates = updateCalls.filter(isSessionsUpdate);
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].where.column).toBe("sessions.id");
    expect(sessionUpdates[0].where.value).toBe("sess-xyz");

    const broadClears = updateCalls.filter(
      (call) => call.where.column === "sessions.userId"
    );
    expect(broadClears).toHaveLength(0);
  });

  it("flips two_factor_enabled on the users row during a session enroll", async () => {
    mockVerifyTOTP.mockResolvedValue({
      headers: headersWithSessionCookie(
        "better-auth.session_token=rawtok123.sigABC; Path=/; HttpOnly"
      ),
    });

    const response = await POST(buildRequest());

    expect(response.status).toBe(200);
    const enableUpdate = updateCalls.find(
      (call) => call.where.column === "users.id"
    );
    expect(enableUpdate?.value).toEqual({ twoFactorEnabled: true });
  });

  it("returns 500 when two_factor_enabled did not persist after verify", async () => {
    mockVerifyTOTP.mockResolvedValue({
      headers: headersWithSessionCookie(
        "better-auth.session_token=rawtok123.sigABC; Path=/; HttpOnly"
      ),
    });
    selectRows.length = 0;
    selectRows.push({ twoFactorEnabled: false });

    const response = await POST(buildRequest());

    expect(response.status).toBe(500);
  });
});
