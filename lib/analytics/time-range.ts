import type { TimeRange } from "./types";

/**
 * Convert a TimeRange to a start Date.
 * Returns the start of the time window (current time minus the range).
 */
export function getTimeRangeStart(
  range: TimeRange,
  customStart?: string
): Date {
  if (range === "custom" && customStart) {
    return new Date(customStart);
  }

  const now = Date.now();
  const offsets: Record<Exclude<TimeRange, "custom">, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  return new Date(now - offsets[range as Exclude<TimeRange, "custom">]);
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
  if (range === "custom" && customStart && customEnd) {
    const startMs = new Date(customStart).getTime();
    const endMs = new Date(customEnd).getTime();
    const duration = endMs - startMs;
    return {
      start: new Date(startMs - duration),
      end: new Date(startMs),
    };
  }

  const now = Date.now();
  const offsets: Record<Exclude<TimeRange, "custom">, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  const offset = offsets[range as Exclude<TimeRange, "custom">];
  return {
    start: new Date(now - offset * 2),
    end: new Date(now - offset),
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
 * The window a request covers. The end is clamped to now so a custom range
 * reaching into the future does not pad the chart with empty buckets.
 */
export function getTimeRangeWindow(
  range: TimeRange,
  customStart?: string,
  customEnd?: string
): { start: Date; end: Date } {
  const now = new Date();
  const start = getTimeRangeStart(range, customStart);
  const requestedEnd = customEnd ? new Date(customEnd) : now;
  const end = requestedEnd.getTime() > now.getTime() ? now : requestedEnd;
  return { start, end };
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
