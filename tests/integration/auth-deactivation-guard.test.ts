import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockCaptureMessage, mockConsoleWarn } = vi.hoisted(
  () => ({
    mockUsersFindFirst: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockConsoleWarn: vi.fn(),
  })
);

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

import { captureMessage } from "@sentry/nextjs";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";

beforeEach(() => {
  vi.clearAllMocks();
  // Spy on console.warn so the structured stdout signal can be asserted.
  // Restored after each test by vi.clearAllMocks.
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    mockConsoleWarn(...args);
  });
});

describe("isUserDeactivated", () => {
  it("returns false for an active user", async () => {
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
    await expect(isUserDeactivated("user-active")).resolves.toBe(false);
  });

  it("returns true for a deactivated user", async () => {
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-05-21T08:41:16Z"),
    });
    await expect(isUserDeactivated("user-deactivated")).resolves.toBe(true);
  });

  it("returns false when the user row does not exist", async () => {
    mockUsersFindFirst.mockResolvedValue(undefined);
    await expect(isUserDeactivated("user-missing")).resolves.toBe(false);
  });
});

/**
 * The hooks below are inlined inside lib/auth.ts as Better Auth config
 * literals, so the test reproduces them verbatim and asserts they behave
 * the same way the OAuth callback path will invoke them. If lib/auth.ts
 * changes the hook bodies, this test must be updated to match (intentional
 * coupling -- this is the spec for the security contract).
 */
type SessionInput = { userId?: unknown };
type AccountInput = { userId?: unknown };

async function sessionCreateBefore(
  session: SessionInput
): Promise<boolean | undefined> {
  const userId = typeof session.userId === "string" ? session.userId : null;
  if (userId && (await isUserDeactivated(userId))) {
    captureMessage("security.deactivated_login_attempt", {
      level: "warning",
      tags: {
        security: "deactivated_login_attempt",
        surface: "session",
      },
      user: { id: userId },
    });
    console.warn(
      JSON.stringify({
        event: "security.deactivated_login_attempt",
        surface: "session",
        userId,
      })
    );
    return false;
  }
  return;
}

async function accountCreateBefore(
  account: AccountInput
): Promise<boolean | undefined> {
  const userId = typeof account.userId === "string" ? account.userId : null;
  if (userId && (await isUserDeactivated(userId))) {
    captureMessage("security.deactivated_login_attempt", {
      level: "warning",
      tags: {
        security: "deactivated_login_attempt",
        surface: "account",
      },
      user: { id: userId },
    });
    console.warn(
      JSON.stringify({
        event: "security.deactivated_login_attempt",
        surface: "account",
        userId,
      })
    );
    return false;
  }
  return;
}

describe("databaseHooks.session.create.before -- OAuth callback path", () => {
  it("allows session creation for an active user", async () => {
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const result = await sessionCreateBefore({ userId: "user-active" });

    expect(result).toBeUndefined();
  });

  it("rejects session creation for a deactivated user", async () => {
    // Reproduces the Barbara-shape scenario: deactivated_at was set by
    // POST /api/user/delete, the attacker comes back via Google OAuth,
    // Better Auth's flow would otherwise mint a fresh session. The hook
    // must return false to abort the sessions row insert.
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-05-21T08:41:16Z"),
    });

    const result = await sessionCreateBefore({ userId: "user-deactivated" });

    expect(result).toBe(false);
    // KEEP-612: hook must also emit the detection signal on both surfaces.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [sentryMessage, sentryOptions] = mockCaptureMessage.mock.calls[0];
    expect(sentryMessage).toBe("security.deactivated_login_attempt");
    expect(sentryOptions).toMatchObject({
      level: "warning",
      tags: {
        security: "deactivated_login_attempt",
        surface: "session",
      },
      user: { id: "user-deactivated" },
    });
    expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
    const stdoutPayload = JSON.parse(mockConsoleWarn.mock.calls[0][0]);
    expect(stdoutPayload).toEqual({
      event: "security.deactivated_login_attempt",
      surface: "session",
      userId: "user-deactivated",
    });
  });

  it("allows session creation when userId is missing or non-string", async () => {
    // Anonymous link / impersonation paths in Better Auth may invoke the
    // hook with a partial session that has no userId yet. The hook must
    // not throw or rely on a DB lookup in that case.
    const result = await sessionCreateBefore({ userId: undefined });

    expect(result).toBeUndefined();
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });
});

describe("databaseHooks.account.create.before -- OAuth re-link path", () => {
  it("allows account linking for an active user", async () => {
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const result = await accountCreateBefore({ userId: "user-active" });

    expect(result).toBeUndefined();
  });

  it("rejects account linking for a deactivated user", async () => {
    // The OAuth re-link gap the user surfaced: an accounts row wiped
    // during incident response is rebuilt by Better Auth's email-match
    // fallback. Without this hook the deactivated users row would get
    // a fresh accounts row linking the OAuth provider back to it, which
    // then satisfies the session create path on the next sign-in.
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-05-21T08:41:16Z"),
    });

    const result = await accountCreateBefore({ userId: "user-deactivated" });

    expect(result).toBe(false);
    // KEEP-612: account surface gets its own tag so triage can disambiguate
    // session-create vs OAuth-relink attempts.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [, sentryOptions] = mockCaptureMessage.mock.calls[0];
    expect(sentryOptions).toMatchObject({
      tags: {
        security: "deactivated_login_attempt",
        surface: "account",
      },
      user: { id: "user-deactivated" },
    });
    expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
    const stdoutPayload = JSON.parse(mockConsoleWarn.mock.calls[0][0]);
    expect(stdoutPayload.surface).toBe("account");
  });

  it("allows account creation when userId is missing", async () => {
    const result = await accountCreateBefore({ userId: undefined });

    expect(result).toBeUndefined();
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });
});
