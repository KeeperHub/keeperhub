import { describe, expect, it } from "vitest";
import {
  decide,
  isAutomatedRun,
  isOutOfFunds,
  type StreakRun,
  summarizeStreak,
} from "@/lib/notifications/failure-alerts/streak";

const BASE = new Date("2026-10-28T12:00:00Z").getTime();

/** Build runs newest first: index 0 is the latest. */
function runs(spec: string[], source = "schedule"): StreakRun[] {
  return spec.map((status, index) => {
    const startedAt = new Date(BASE - index * 15 * 60 * 1000);
    const [plainStatus, override] = status.split(":");
    return {
      id: `run-${index}`,
      status: plainStatus,
      triggerSource: override === "manual" ? "manual" : source,
      credentialType: override === "manual" ? "session" : null,
      startedAt,
      completedAt: new Date(startedAt.getTime() + 1000),
      error: plainStatus === "error" ? `boom ${index}` : null,
    };
  });
}

describe("isAutomatedRun", () => {
  it.each([
    ["schedule", null, true],
    ["webhook", null, true],
    ["event", null, true],
    ["block", null, true],
    ["internal", null, true],
    ["manual", "session", false],
    ["manual", null, false],
    // An API call without a trigger header is recorded as manual, but it is
    // automation and must count.
    ["manual", "org_api_key", true],
    ["manual", "webhook_key", true],
  ])("trigger %s with credential %s -> %s", (source, credential, expected) => {
    expect(
      isAutomatedRun({ triggerSource: source, credentialType: credential })
    ).toBe(expected);
  });
});

describe("summarizeStreak", () => {
  it("counts consecutive failures up to the last success", () => {
    const summary = summarizeStreak(
      runs(["error", "error", "error", "success", "error"]),
      null,
      10
    );
    expect(summary.failures).toBe(3);
    expect(summary.lastFailedRunId).toBe("run-0");
    expect(summary.lastError).toBe("boom 0");
    expect(summary.firstFailedAt?.getTime()).toBe(BASE - 2 * 15 * 60 * 1000);
    expect(summary.latestSuccessRunId).toBeNull();
  });

  it("steps over refused, cancelled, unsettled and platform-error runs", () => {
    const summary = summarizeStreak(
      runs([
        "error",
        "skipped",
        "error",
        "cancelled",
        "system_error",
        "unconfirmed",
        "error",
        "success",
      ]),
      null,
      10
    );
    expect(summary.failures).toBe(3);
  });

  it("ignores manual runs in both directions", () => {
    const summary = summarizeStreak(
      runs(["success:manual", "error", "error:manual", "error"]),
      null,
      10
    );
    expect(summary.failures).toBe(2);
    expect(summary.latestSuccessRunId).toBeNull();
  });

  it("reports the success that ended a streak", () => {
    const summary = summarizeStreak(runs(["success", "error"]), null, 10);
    expect(summary.failures).toBe(0);
    expect(summary.latestSuccessRunId).toBe("run-0");
  });

  it("drops runs that finished before counting started", () => {
    const countingSince = new Date(BASE - 20 * 60 * 1000);
    const summary = summarizeStreak(
      runs(["error", "error", "error", "error", "error"]),
      countingSince,
      10
    );
    expect(summary.failures).toBe(2);
  });

  it("flags a window full of failures as possibly longer", () => {
    const summary = summarizeStreak(runs(["error", "error", "error"]), null, 3);
    expect(summary.truncated).toBe(true);
  });
});

describe("decide", () => {
  const now = new Date(BASE);
  const failing = (failures: number, firstMinutesAgo: number) =>
    ({
      failures,
      firstFailedAt: new Date(BASE - firstMinutesAgo * 60 * 1000),
      lastFailedAt: now,
      lastFailedRunId: "run-0",
      lastError: "boom",
      latestSuccessRunId: null,
      truncated: false,
      outOfFunds: 0,
    }) as const;

  it("opens at the threshold", () => {
    expect(
      decide({
        summary: failing(5, 75),
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: false,
        now,
      })
    ).toEqual({ kind: "open", by: "count" });
  });

  it("stays quiet below the threshold with no time limit", () => {
    expect(
      decide({
        summary: failing(4, 600),
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: false,
        now,
      })
    ).toEqual({ kind: "none" });
  });

  it("opens on the time limit for a slow schedule", () => {
    expect(
      decide({
        summary: failing(2, 361),
        threshold: 5,
        timeLimitMinutes: 360,
        hasOpenIncident: false,
        now,
      })
    ).toEqual({ kind: "open", by: "time" });
  });

  it("asks to be looked at again when the time limit falls due", () => {
    expect(
      decide({
        summary: failing(1, 60),
        threshold: 5,
        timeLimitMinutes: 360,
        hasOpenIncident: false,
        now,
      })
    ).toEqual({ kind: "recheck", at: new Date(BASE + 300 * 60 * 1000) });
  });

  it("never opens a second incident for the same streak", () => {
    expect(
      decide({
        summary: failing(9, 200),
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: true,
        now,
      })
    ).toEqual({ kind: "none" });
  });

  it("resolves an open incident on an automated success", () => {
    expect(
      decide({
        summary: {
          ...failing(0, 0),
          failures: 0,
          firstFailedAt: null,
          latestSuccessRunId: "run-0",
        },
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: true,
        now,
      })
    ).toEqual({ kind: "resolve" });
  });
});

describe("wallet out of funds", () => {
  const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60 * 1000);
  const failed = (minutesAgo: number, error: string) => ({
    id: `r${minutesAgo}`,
    status: "error",
    triggerSource: "schedule",
    credentialType: null,
    startedAt: at(minutesAgo),
    completedAt: at(minutesAgo),
    error,
  });
  const shortfall = "insufficient funds for gas * price + value: have 4 want 6";

  it("recognises the chain's and our pre-send shortfall messages", () => {
    expect(isOutOfFunds(shortfall)).toBe(true);
    expect(
      isOutOfFunds("Insufficient ETH balance. Have: 0.0004, Need: 0.0006")
    ).toBe(true);
    expect(isOutOfFunds("execution reverted")).toBe(false);
    expect(isOutOfFunds(null)).toBe(false);
  });

  it("alerts after two shortfalls in a row, below the normal limit", () => {
    const summary = summarizeStreak(
      [failed(1, shortfall), failed(2, shortfall)],
      null,
      20
    );
    expect(summary.outOfFunds).toBe(2);
    expect(
      decide({
        summary,
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: false,
        now: new Date(BASE),
      })
    ).toEqual({ kind: "open", by: "funding" });
  });

  it("needs the newest failures to be shortfalls, in a row", () => {
    const summary = summarizeStreak(
      [
        failed(1, "execution reverted"),
        failed(2, shortfall),
        failed(3, shortfall),
      ],
      null,
      20
    );
    expect(summary.outOfFunds).toBe(0);
    expect(
      decide({
        summary,
        threshold: 5,
        timeLimitMinutes: null,
        hasOpenIncident: false,
        now: new Date(BASE),
      }).kind
    ).toBe("none");
  });
});
