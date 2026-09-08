import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawConsole } from "@/lib/log/core";

// logSecurityEvent writes the structured line via lib/log/core's rawConsole.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

const { isKh001SessionBackstop, reportSessionBackstop } = await import(
  "@/lib/security/session-backstop"
);

describe("isKh001SessionBackstop", () => {
  it("matches a top-level KH001 SQLSTATE", () => {
    expect(isKh001SessionBackstop({ code: "KH001" })).toBe(true);
  });

  it("matches KH001 on a nested cause (Better Auth wrapping)", () => {
    // Better Auth wraps adapter errors; the postgres SQLSTATE lands on cause.
    const wrapped = new Error("Failed to create session");
    (wrapped as Error & { cause: unknown }).cause = { code: "KH001" };
    expect(isKh001SessionBackstop(wrapped)).toBe(true);
  });

  it("matches KH001 two causes deep", () => {
    const err = {
      message: "outer",
      cause: { message: "mid", cause: { code: "KH001" } },
    };
    expect(isKh001SessionBackstop(err)).toBe(true);
  });

  it("falls back to the trigger message when the SQLSTATE was stripped", () => {
    expect(
      isKh001SessionBackstop({
        message: "Session owner is deactivated; new sessions are not allowed.",
      })
    ).toBe(true);
  });

  it("matches the message fragment on a nested cause", () => {
    expect(
      isKh001SessionBackstop({
        message: "db error",
        cause: { message: "Session owner is deactivated" },
      })
    ).toBe(true);
  });

  it("does not match an unrelated postgres error", () => {
    expect(isKh001SessionBackstop({ code: "23505" })).toBe(false);
  });

  it("does not match an unrelated message", () => {
    expect(
      isKh001SessionBackstop({ message: "duplicate key value violates unique" })
    ).toBe(false);
  });

  it("handles null / undefined / primitive without throwing", () => {
    expect(isKh001SessionBackstop(null)).toBe(false);
    expect(isKh001SessionBackstop(undefined)).toBe(false);
    expect(isKh001SessionBackstop("KH001")).toBe(false);
  });

  it("terminates on a self-referential cause cycle (bounded walk)", () => {
    const a: { code: string; cause?: unknown } = { code: "nope" };
    a.cause = a;
    expect(isKh001SessionBackstop(a)).toBe(false);
  });
});

describe("reportSessionBackstop (onAPIError emit wiring)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    mockCaptureMessage.mockReset();
    warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // assert against the spy, suppress noise
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.LOG_LEVEL = originalLevel;
  });

  it("emits Sentry + structured stdout and returns true on a wrapped KH001", () => {
    const wrapped = new Error("Failed to create session");
    (wrapped as Error & { cause: unknown }).cause = { code: "KH001" };

    const fired = reportSessionBackstop(wrapped);

    expect(fired).toBe(true);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      { tags: Record<string, string> },
    ];
    expect(message).toBe("security.backstop_session_blocked");
    expect(options.tags).toMatchObject({
      security: "backstop_session_blocked",
      surface: "session",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
      level: "warn",
      event: "security.backstop_session_blocked",
    });
  });

  it("no-ops and returns false on an unrelated error", () => {
    const fired = reportSessionBackstop({ code: "23505" });
    expect(fired).toBe(false);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still logs + returns true when Sentry capture throws", () => {
    mockCaptureMessage.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const fired = reportSessionBackstop({ code: "KH001" });
    expect(fired).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
