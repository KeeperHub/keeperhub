/**
 * KEEP-1042: the two ends of an analytics window come off the query string, so
 * both have to survive a caller sending nonsense. `customStart` was fixed when
 * retention gave the range a floor; `customEnd` kept the original bug, and an
 * unparseable value made every downstream comparison answer false and the
 * endpoint return "Invalid time value" instead of a result.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/retention/config", () => ({
  getRetentionConfig: () => ({ executionRetentionDays: 400 }),
  daysBefore: (now: Date, days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
}));

import { getTimeRangeEnd, getTimeRangeStart } from "@/lib/analytics/time-range";

describe("getTimeRangeEnd", () => {
  it("returns now when no customEnd is given", () => {
    const before = Date.now();
    const end = getTimeRangeEnd().getTime();
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(Date.now());
  });

  it.each(["garbage", "", "2026-13-45", "not-a-date"])(
    "falls back to now rather than an Invalid Date for %o",
    (value) => {
      expect(Number.isNaN(getTimeRangeEnd(value).getTime())).toBe(false);
    }
  );

  it("keeps a parseable customEnd", () => {
    expect(getTimeRangeEnd("2026-08-01T00:00:00.000Z").toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
  });

  it("clamps a future customEnd to now", () => {
    const end = getTimeRangeEnd("2099-01-01T00:00:00.000Z").getTime();
    expect(end).toBeLessThanOrEqual(Date.now());
  });

  it("never returns an end before the start it is paired with", () => {
    const start = getTimeRangeStart("custom", "2026-08-01T00:00:00.000Z");
    const end = getTimeRangeEnd("garbage");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});
