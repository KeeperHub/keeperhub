import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const USER_EMAIL = "user@techops.services";

const { mockResolveCaller, mockRequireDualFactor, state, insertCalls } =
  vi.hoisted(() => ({
    mockResolveCaller: vi.fn(),
    mockRequireDualFactor: vi.fn(),
    state: {
      userRow: undefined as { twoFactorEnabled: boolean } | undefined,
      factorRow: undefined as { id: string } | undefined,
    },
    insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  }));

vi.mock("@/lib/enroll-mfa-caller", () => ({
  resolveEnrollMfaCaller: mockResolveCaller,
}));

vi.mock("@/lib/mfa/dual-factor", () => ({
  requireDualFactor: mockRequireDualFactor,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const isUsers =
              (table as { twoFactorEnabled?: unknown }).twoFactorEnabled !==
              undefined;
            if (isUsers) {
              return Promise.resolve(state.userRow ? [state.userRow] : []);
            }
            return Promise.resolve(state.factorRow ? [state.factorRow] : []);
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => ({
        onConflictDoUpdate: vi.fn(() => {
          insertCalls.push({ table, values });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "users.id", twoFactorEnabled: "users.twoFactorEnabled" },
  twoFactor: {
    id: "twoFactor.id",
    userId: "twoFactor.userId",
    secret: "twoFactor.secret",
    backupCodes: "twoFactor.backupCodes",
    name: "twoFactor.name",
    enrolledAt: "twoFactor.enrolledAt",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH", CONFIGURATION: "CONFIGURATION" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/user/totp/setup/route";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/totp/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;
  state.userRow = undefined;
  state.factorRow = undefined;
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-1234567890";
  mockResolveCaller.mockResolvedValue({
    kind: "session",
    userId: USER_ID,
    email: USER_EMAIL,
  });
});

describe("POST /api/user/totp/setup", () => {
  it("mints without a dual-factor gate for a first-time enroll (no row, not enabled)", async () => {
    state.userRow = { twoFactorEnabled: false };
    state.factorRow = undefined;

    const response = await POST(buildRequest({}));

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      totpUri: string;
      manualEntryKey: string;
    };
    expect(typeof data.totpUri).toBe("string");
    expect(data.totpUri.startsWith("otpauth://totp/")).toBe(true);
    expect(typeof data.manualEntryKey).toBe("string");
    expect(mockRequireDualFactor).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
  });

  it("mints without a gate for a pending-signup caller", async () => {
    mockResolveCaller.mockResolvedValue({
      kind: "pending-signup",
      userId: USER_ID,
      email: USER_EMAIL,
      redirect: "/",
    });
    state.userRow = { twoFactorEnabled: false };
    state.factorRow = undefined;

    const response = await POST(buildRequest({}));

    expect(response.status).toBe(200);
    expect(mockRequireDualFactor).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
  });

  it("allows a pending-enrollment re-run (row exists but not yet enabled) without a gate", async () => {
    state.userRow = { twoFactorEnabled: false };
    state.factorRow = { id: "tf-1" };

    const response = await POST(buildRequest({}));

    expect(response.status).toBe(200);
    expect(mockRequireDualFactor).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
  });

  it("gates an already-enrolled rotation and does NOT overwrite when dual-factor is required", async () => {
    state.userRow = { twoFactorEnabled: true };
    state.factorRow = { id: "tf-1" };
    mockRequireDualFactor.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Enter the codes",
      code: "factors_required",
    });

    const response = await POST(buildRequest({}));

    expect(response.status).toBe(401);
    const data = (await response.json()) as { code: string };
    expect(data.code).toBe("factors_required");
    expect(mockRequireDualFactor).toHaveBeenCalledTimes(1);
    expect(mockRequireDualFactor).toHaveBeenCalledWith(
      expect.objectContaining({ action: "totp_setup", userId: USER_ID })
    );
    // The secret must NOT have been overwritten when proof is missing.
    expect(insertCalls).toHaveLength(0);
  });

  it("proceeds with the rotation once dual-factor succeeds", async () => {
    state.userRow = { twoFactorEnabled: true };
    state.factorRow = { id: "tf-1" };
    mockRequireDualFactor.mockResolvedValue({ ok: true });

    const response = await POST(
      buildRequest({ code: "123456", emailOtp: "654321" })
    );

    expect(response.status).toBe(200);
    expect(mockRequireDualFactor).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
  });

  it("rejects an anonymous caller without touching the gate or the upsert", async () => {
    mockResolveCaller.mockResolvedValue({
      kind: "anonymous",
      reason: "no_auth",
    });

    const response = await POST(buildRequest({}));

    expect(response.status).toBe(401);
    expect(mockRequireDualFactor).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});
