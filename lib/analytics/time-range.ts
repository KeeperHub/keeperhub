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

/**
 * Compute time-series bucket size based on the range.
 * Returns the bucket interval in milliseconds and a SQL interval string.
 */
export function getBucketInterval(range: TimeRange): {
  intervalMs: number;
  sqlInterval: string;
} {
  switch (range) {
    case "1h": {
      return { intervalMs: 5 * 60 * 1000, sqlInterval: "5 minutes" };
    }
    case "24h": {
      return { intervalMs: 60 * 60 * 1000, sqlInterval: "1 hour" };
    }
    case "7d": {
      return { intervalMs: 6 * 60 * 60 * 1000, sqlInterval: "6 hours" };
    }
    case "30d": {
      return { intervalMs: 24 * 60 * 60 * 1000, sqlInterval: "1 day" };
    }
    case "custom": {
      return { intervalMs: 60 * 60 * 1000, sqlInterval: "1 hour" };
    }
    default: {
      return { intervalMs: 60 * 60 * 1000, sqlInterval: "1 hour" };
    }
  }
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
