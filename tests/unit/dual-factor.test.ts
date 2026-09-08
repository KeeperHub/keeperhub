import { createHmac } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSelect, mockInsert, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  twoFactor: { userId: "user_id", secret: "secret" },
  verifications: {
    id: "id",
    identifier: "identifier",
    value: "value",
    expiresAt: "expires_at",
  },
}));

const { mockSendVerificationOTP } = vi.hoisted(() => ({
  mockSendVerificationOTP: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendVerificationOTP: mockSendVerificationOTP,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "auth", CONFIGURATION: "configuration" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/utils/id", () => ({
  generateId: (): string => "test-id",
}));

const { mockResetDualFactor } = vi.hoisted(() => ({
  mockResetDualFactor: vi.fn(),
}));

vi.mock("@/lib/mfa/dual-factor-rate-limit", () => ({
  checkDualFactorRateLimit: (): { allowed: true } => ({ allowed: true }),
  resetDualFactor: mockResetDualFactor,
}));

import { requireDualFactor } from "@/lib/mfa/dual-factor";

const SERVER_SECRET = "unit-test-server-secret-32-bytes-long";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

/**
 * Generates the TOTP code that lib/security/totp-verify.ts will accept
 * for the current 30-second window. Same RFC 6238 algorithm; we
 * regenerate it here rather than importing to keep the test free of
 * a coupling that could mask a regression in the verify path.
 */
function totpForNow(secret: string): string {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(buf)
    .digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (truncated % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

function selectChain(rows: unknown[]): {
  from: () => { where: () => { limit: () => Promise<unknown[]> } };
} {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SERVER_SECRET;
  vi.clearAllMocks();
  mockSendVerificationOTP.mockResolvedValue(true);
  mockInsert.mockReturnValue({ values: () => Promise.resolve(undefined) });
  mockDelete.mockReturnValue({ where: () => Promise.resolve(undefined) });
});

describe("requireDualFactor", () => {
  // Regression for the KEEP-619 OAuth-MFA bug: before the fix, this
  // gate called auth.api.verifyTOTP which requires either an active
  // session or the TWO_FACTOR_COOKIE_NAME cookie. interceptOauthCallback
  // destroys the session before routing to oauth-mfa-finalize, leaving
  // only pending_oauth_mfa, so every OAuth-with-TOTP sign-in failed
  // with "Invalid authenticator code" regardless of the code submitted.
  // The fix verifies TOTP against two_factor.secret directly. This test
  // would have failed under the old code (the @/lib/auth import would
  // pull in the full Better Auth runtime in unit-test context and the
  // call would throw without a session).
  it("accepts a valid TOTP + email OTP without an active session", async () => {
    const encSecret = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: TOTP_SECRET,
    });
    const encEmailOtp = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: "123456",
    });
    mockSelect
      .mockReturnValueOnce(selectChain([{ secret: encSecret }]))
      .mockReturnValueOnce(
        selectChain([{ id: "verif_1", value: encEmailOtp }])
      );

    const result = await requireDualFactor({
      userId: "user_1",
      email: "user@example.com",
      action: "oauth_mfa_finalize",
      code: totpForNow(TOTP_SECRET),
      emailOtp: "123456",
      headers: new Headers(),
    });

    expect(result).toEqual({ ok: true });
    expect(mockResetDualFactor).toHaveBeenCalledWith(
      "user_1",
      "oauth_mfa_finalize"
    );
  });

  it("returns mfa_code_invalid when the TOTP code is wrong", async () => {
    const encSecret = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: TOTP_SECRET,
    });
    mockSelect.mockReturnValueOnce(selectChain([{ secret: encSecret }]));

    const result = await requireDualFactor({
      userId: "user_2",
      email: "user@example.com",
      action: "oauth_mfa_finalize",
      code: "000000",
      emailOtp: "123456",
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "mfa_code_invalid",
    });
  });

  it("returns mfa_code_invalid (not a distinct enrollment code) when no two_factor row exists", async () => {
    // Don't leak enrollment state. Strict-signin uses a distinct
    // totp_not_configured code because it is the sign-in entry point;
    // requireDualFactor is invoked only after the user has already
    // proved they have TOTP set up, so any missing row is a data
    // anomaly that should look identical to a wrong code.
    mockSelect.mockReturnValueOnce(selectChain([]));

    const result = await requireDualFactor({
      userId: "user_3",
      email: "user@example.com",
      action: "oauth_mfa_finalize",
      code: "000000",
      emailOtp: "123456",
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "mfa_code_invalid",
    });
  });

  it("returns email_code_invalid when the verifications row is missing or expired", async () => {
    const encSecret = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: TOTP_SECRET,
    });
    mockSelect
      .mockReturnValueOnce(selectChain([{ secret: encSecret }]))
      .mockReturnValueOnce(selectChain([]));

    const result = await requireDualFactor({
      userId: "user_4",
      email: "user@example.com",
      action: "oauth_mfa_finalize",
      code: totpForNow(TOTP_SECRET),
      emailOtp: "123456",
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "email_code_invalid",
    });
  });

  // F-003: the dual-factor gate must never write the user's live TOTP
  // code to logs. A leaked code is replayable inside its time window and
  // is a secrets-in-logs compliance violation.
  it("never logs the plaintext TOTP code", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // swallow log output during the assertion
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // swallow log output during the assertion
    });
    const totp = totpForNow(TOTP_SECRET);
    const encSecret = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: TOTP_SECRET,
    });
    const encEmailOtp = await symmetricEncrypt({
      key: SERVER_SECRET,
      data: "123456",
    });
    mockSelect
      .mockReturnValueOnce(selectChain([{ secret: encSecret }]))
      .mockReturnValueOnce(
        selectChain([{ id: "verif_1", value: encEmailOtp }])
      );

    await requireDualFactor({
      userId: "user_log",
      email: "user@example.com",
      action: "oauth_signin",
      code: totp,
      emailOtp: "123456",
      headers: new Headers(),
    });

    const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
      .map((c) => JSON.stringify(c))
      .join(" ");
    expect(logged).not.toContain(totp);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("mints and emails an OTP and returns factors_required when codes are missing", async () => {
    const result = await requireDualFactor({
      userId: "user_5",
      email: "user@example.com",
      action: "oauth_mfa_finalize",
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "factors_required",
    });
    expect(mockSendVerificationOTP).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});
