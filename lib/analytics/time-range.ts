import "server-only";

import { daysBefore, getRetentionConfig } from "@/lib/retention/config";
import type { TimeRange } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PRESET_OFFSETS: Record<Exclude<TimeRange, "custom">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": MS_PER_DAY,
  "7d": 7 * MS_PER_DAY,
  "30d": 30 * MS_PER_DAY,
};
const DEFAULT_RANGE: Exclude<TimeRange, "custom"> = "24h";

/**
 * The furthest back any analytics query may reach.
 *
 * `customStart` arrives straight off the query string and had no floor, so
 * `?range=custom&customStart=2020-01-01` scanned the whole table and, because
 * a custom range also bypasses the result cache, hit Postgres directly every
 * time. That is the cheapest way to reproduce the 2026-09-02 saturation.
 *
 * The bound is the retention window for run rows, so it hides nothing: no
 * execution older than this survives once retention is on, and today the table
 * does not reach that far back at all.
 */
export function getAnalyticsFloor(now: Date = new Date()): Date {
  return daysBefore(now, getRetentionConfig().executionRetentionDays);
}

/**
 * Convert a TimeRange to a start Date.
 * Returns the start of the time window (current time minus the range).
 */
export function getTimeRangeStart(
  range: TimeRange,
  customStart?: string
): Date {
  const now = new Date();
  const floor = getAnalyticsFloor(now);

  if (range === "custom") {
    const parsed = customStart ? new Date(customStart) : null;
    // `custom` with no (or an unparseable) customStart used to index an offsets
    // table that has no "custom" key, producing an Invalid Date that every
    // downstream comparison then answered false to.
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return new Date(now.getTime() - PRESET_OFFSETS[DEFAULT_RANGE]);
    }
    return parsed < floor ? floor : parsed;
  }

  const offset = PRESET_OFFSETS[range as Exclude<TimeRange, "custom">];
  const start = new Date(
    now.getTime() - (offset ?? PRESET_OFFSETS[DEFAULT_RANGE])
  );
  return start < floor ? floor : start;
}

/**
 * The end of the window, from an optional `customEnd` off the query string.
 *
 * Same guard as the start above, for the same reason. `new Date(customEnd)`
 * with no validation yields an Invalid Date for anything unparseable, and every
 * comparison against it answers false: the analytics endpoints returned
 * "Invalid time value" rather than a result. An absent or unparseable value
 * means now, which is what a caller asking for an open-ended window wants.
 */
export function getTimeRangeEnd(customEnd?: string): Date {
  const now = new Date();
  const parsed = customEnd ? new Date(customEnd) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return now;
  }
  return parsed > now ? now : parsed;
}

/**
 * Get the previous period start for comparison deltas.
 * e.g. if range is 24h, previous period is 48h-24h ago.
 */
export function getPreviousPeriodStart(
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): { start: Date; end: Date } {
  const floorMs = getAnalyticsFloor().getTime();
  // The comparison period sits one window further back than the window itself,
  // so it is the first thing to fall off the end of retention. Clamped to the
  // same floor: a previous period that reaches past it can only ever compare
  // against rows that are not there.
  const clamp = (value: number) => (value < floorMs ? floorMs : value);

  if (range === "custom" && customStart && customEnd) {
    const startMs = new Date(customStart).getTime();
    const endMs = new Date(customEnd).getTime();
    const duration = endMs - startMs;
    return {
      start: new Date(clamp(startMs - duration)),
      end: new Date(clamp(startMs)),
    };
  }

  const now = Date.now();
  const offset =
    PRESET_OFFSETS[range as Exclude<TimeRange, "custom">] ??
    PRESET_OFFSETS[DEFAULT_RANGE];
  return {
    start: new Date(clamp(now - offset * 2)),
    end: new Date(clamp(now - offset)),
  };
}

/** Bucket widths the time-series query knows how to truncate to. */
export type BucketSqlInterval = "5 minutes" | "1 hour" | "6 hours" | "1 day";

export type BucketInterval = {
  intervalMs: number;
  sqlInterval: BucketSqlInterval;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Bucket width from the width of the window itself, not from the range name.
 * A custom window is as wide as the caller made it, so keying off the name left
 * every hand-picked range on hourly buckets - a two-month window came back as
 * ~1500 points with four identical day labels per day. The rungs are chosen so
 * the named ranges keep the widths they already had: 1h -> 5m, 24h -> 1h,
 * 7d -> 6h, 30d -> 1d.
 */
export function getBucketInterval(windowMs: number): BucketInterval {
  if (windowMs <= 2 * HOUR_MS) {
    return { intervalMs: 5 * MINUTE_MS, sqlInterval: "5 minutes" };
  }
  if (windowMs <= 2 * DAY_MS) {
    return { intervalMs: HOUR_MS, sqlInterval: "1 hour" };
  }
  if (windowMs <= 14 * DAY_MS) {
    return { intervalMs: 6 * HOUR_MS, sqlInterval: "6 hours" };
  }
  return { intervalMs: DAY_MS, sqlInterval: "1 day" };
}

/**
 * The window a request covers. The end goes through getTimeRangeEnd, so a
 * custom range reaching into the future does not pad the chart with empty
 * buckets, and an unparseable end falls back to now instead of throwing.
 */
export function getTimeRangeWindow(
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): { start: Date; end: Date } {
  return {
    start: getTimeRangeStart(range, customStart),
    end: getTimeRangeEnd(customEnd),
  };
}

/**
 * Parse and validate a TimeRange from a query string parameter.
 */
export function parseTimeRange(value: string | null): TimeRange {
  const valid: TimeRange[] = ["1h", "24h", "7d", "30d", "custom"];
  if (value && valid.includes(value as TimeRange)) {
    return value as TimeRange;
  }
  return "24h";
}

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Validate an IANA time zone name coming off the query string. Buckets are
 * truncated in the viewer's zone, so this string reaches SQL (as a bound
 * parameter) - anything Intl does not recognise falls back to UTC rather than
 * being passed through.
 */
export function parseTimeZone(value: string | null): string {
  if (!value) {
    return "UTC";
  }
  // Names only. Intl also accepts bare UTC offsets ("+03:00"), which Postgres
  // reads with the opposite sign convention.
  if (!IANA_NAME.test(value)) {
    return "UTC";
  }
  try {
    // Throws RangeError on a zone the runtime does not know.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    // The caller's spelling, not Intl's canonical one: Intl maps some zones
    // onto older aliases, and the name is what reaches Postgres.
    return value;
  } catch {
    return "UTC";
  }
}
