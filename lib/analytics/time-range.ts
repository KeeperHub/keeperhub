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
