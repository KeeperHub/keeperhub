import { describe, expect, it } from "vitest";
import {
  graceFor,
  lastDueAt,
  missedDueAt,
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
  it("flags a schedule with no run since it was due past the grace", () => {
    const due = missedDueAt({
      schedule: every5,
      lastStartedAt: longAgo,
      notBefore: longAgo,
      now,
    });
    expect(due?.toISOString()).toBe("2026-10-28T12:20:00.000Z");
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
