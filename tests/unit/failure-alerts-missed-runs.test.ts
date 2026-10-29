import { describe, expect, it } from "vitest";
import {
  graceFor,
  lastDueAt,
  missedDueAt,
  nextDueAfter,
} from "@/lib/notifications/failure-alerts/missed-runs";

const every5 = {
  cronExpression: "*/5 * * * *",
  timezone: "UTC",
  intervalSeconds: null,
  anchorAt: null,
};
const now = new Date("2026-10-28T12:32:30Z");
const longAgo = new Date("2026-10-28T10:00:00Z");

describe("lastDueAt", () => {
  it("finds the latest cron occurrence at or before a time", () => {
    expect(
      lastDueAt(every5, new Date("2026-10-28T12:22:30Z"))?.toISOString()
    ).toBe("2026-10-28T12:20:00.000Z");
  });

  it("counts interval schedules from their anchor", () => {
    const interval = {
      ...every5,
      intervalSeconds: 55 * 60,
      anchorAt: new Date("2026-10-28T10:00:00Z"),
    };
    expect(
      lastDueAt(interval, new Date("2026-10-28T12:00:00Z"))?.toISOString()
    ).toBe("2026-10-28T11:50:00.000Z");
  });

  it("returns null for an invalid cron", () => {
    expect(lastDueAt({ ...every5, cronExpression: "nope" }, now)).toBeNull();
  });
});

describe("missedDueAt", () => {
  it("names the first run it missed, not the latest", () => {
    const due = missedDueAt({
      schedule: every5,
      lastStartedAt: longAgo,
      notBefore: longAgo,
      now,
    });
    expect(due?.toISOString()).toBe("2026-10-28T10:05:00.000Z");
  });

  it("starts after the last run, counting a slightly early run as on time", () => {
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: new Date("2026-10-28T12:04:30Z"),
        notBefore: longAgo,
        now,
      })?.toISOString()
    ).toBe("2026-10-28T12:10:00.000Z");
  });

  it("starts after notBefore when it never ran", () => {
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: null,
        notBefore: new Date("2026-10-28T12:12:00Z"),
        now,
      })?.toISOString()
    ).toBe("2026-10-28T12:15:00.000Z");
  });

  it("keeps the first missed time as an outage goes on, so a hold on it can end", () => {
    const later = new Date("2026-10-28T13:30:00Z");
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: new Date("2026-10-28T12:00:10Z"),
        notBefore: longAgo,
        now: later,
      })?.toISOString()
    ).toBe("2026-10-28T12:05:00.000Z");
  });

  it("is fine when a run started at the due time", () => {
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: new Date("2026-10-28T12:20:20Z"),
        notBefore: longAgo,
        now,
      })
    ).toBeNull();
  });

  it("waits out the grace period", () => {
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: new Date("2026-10-28T12:25:05Z"),
        notBefore: longAgo,
        now,
      })
    ).toBeNull();
  });

  it("ignores due times before the schedule existed or counting started", () => {
    expect(
      missedDueAt({
        schedule: every5,
        lastStartedAt: null,
        notBefore: new Date("2026-10-28T12:21:00Z"),
        now,
      })
    ).toBeNull();
  });
});

describe("nextDueAfter", () => {
  it("is strictly after the given time", () => {
    expect(
      nextDueAfter(every5, new Date("2026-10-28T12:05:00Z"))?.toISOString()
    ).toBe("2026-10-28T12:10:00.000Z");
  });

  it("counts interval schedules from their anchor", () => {
    const interval = {
      ...every5,
      intervalSeconds: 55 * 60,
      anchorAt: new Date("2026-10-28T10:00:00Z"),
    };
    expect(
      nextDueAfter(interval, new Date("2026-10-28T10:56:00Z"))?.toISOString()
    ).toBe("2026-10-28T11:50:00.000Z");
    expect(
      nextDueAfter(interval, new Date("2026-10-28T09:00:00Z"))?.toISOString()
    ).toBe("2026-10-28T10:55:00.000Z");
  });
});

describe("graceFor", () => {
  it("is twice the interval, between 2 and 10 minutes", () => {
    const at = new Date("2026-10-28T12:00:30Z");
    expect(graceFor({ ...every5, cronExpression: "* * * * *" }, at)).toBe(
      2 * 60_000
    );
    expect(graceFor({ ...every5, cronExpression: "*/3 * * * *" }, at)).toBe(
      6 * 60_000
    );
    expect(graceFor(every5, at)).toBe(10 * 60_000);
    expect(graceFor({ ...every5, cronExpression: "0 * * * *" }, at)).toBe(
      10 * 60_000
    );
  });
});
