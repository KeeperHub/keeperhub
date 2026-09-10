import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBucketInterval,
  getTimeRangeWindow,
  parseTimeZone,
} from "@/lib/analytics/time-range";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("getBucketInterval", () => {
  it("keeps the widths the named ranges already had", () => {
    expect(getBucketInterval(HOUR)).toEqual({
      intervalMs: 5 * MINUTE,
      sqlInterval: "5 minutes",
    });
    expect(getBucketInterval(24 * HOUR)).toEqual({
      intervalMs: HOUR,
      sqlInterval: "1 hour",
    });
    expect(getBucketInterval(7 * DAY)).toEqual({
      intervalMs: 6 * HOUR,
      sqlInterval: "6 hours",
    });
    expect(getBucketInterval(30 * DAY)).toEqual({
      intervalMs: DAY,
      sqlInterval: "1 day",
    });
  });

  it("widens the bucket with the window instead of staying hourly", () => {
    // The reported case: a two-month hand-picked window came back hourly, so
    // the axis printed the same day over and over.
    expect(getBucketInterval(60 * DAY).sqlInterval).toBe("1 day");
    expect(getBucketInterval(365 * DAY).sqlInterval).toBe("1 day");
  });

  it("puts each rung's boundary in the narrower bucket", () => {
    expect(getBucketInterval(2 * HOUR).sqlInterval).toBe("5 minutes");
    expect(getBucketInterval(2 * HOUR + 1).sqlInterval).toBe("1 hour");
    expect(getBucketInterval(2 * DAY).sqlInterval).toBe("1 hour");
    expect(getBucketInterval(2 * DAY + 1).sqlInterval).toBe("6 hours");
    expect(getBucketInterval(14 * DAY).sqlInterval).toBe("6 hours");
    expect(getBucketInterval(14 * DAY + 1).sqlInterval).toBe("1 day");
  });
});

describe("getTimeRangeWindow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clamps a window that reaches into the future back to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T22:00:00Z"));

    const { start, end } = getTimeRangeWindow(
      "custom",
      "2026-09-01T03:00:00Z",
      "2026-10-28T02:59:59Z"
    );

    expect(start.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-10T22:00:00.000Z");
  });

  it("ends a named range at now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T22:00:00Z"));

    const { start, end } = getTimeRangeWindow("24h");

    expect(start.toISOString()).toBe("2026-09-09T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-10T22:00:00.000Z");
  });
});

describe("parseTimeZone", () => {
  it("accepts an IANA zone name", () => {
    expect(parseTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires"
    );
    expect(parseTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back to UTC when the zone is missing or unknown", () => {
    expect(parseTimeZone(null)).toBe("UTC");
    expect(parseTimeZone("")).toBe("UTC");
    expect(parseTimeZone("Mars/Olympus_Mons")).toBe("UTC");
  });

  it("rejects a bare offset, which Postgres reads with the other sign", () => {
    expect(parseTimeZone("+03:00")).toBe("UTC");
    expect(parseTimeZone("-05:00")).toBe("UTC");
  });

  it("rejects anything carrying SQL punctuation", () => {
    expect(parseTimeZone("UTC'; DROP TABLE workflow_executions; --")).toBe(
      "UTC"
    );
  });
});
