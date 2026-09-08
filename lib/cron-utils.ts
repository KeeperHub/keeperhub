import { CronExpressionParser } from "cron-parser";

// Regex for splitting cron expression fields
const CRON_FIELD_SPLITTER = /\s+/;
const INTERVAL_PATTERN = /^\*\/(\d+)$/;
const RANGE_PATTERN = /^(\d+)-(\d+)$/;

/**
 * KEEP-575: coerce a `scheduleIntervalSeconds` value (number or numeric
 * string from the trigger config JSONB) into a positive integer, or null
 * if the value is missing or unusable.
 *
 * Lives in cron-utils (not schedule-service) so client components can
 * import it without dragging the server-only DB connection into the
 * browser bundle.
 *
 * KEEP-581: throw IntervalTooSmallError for sub-MIN_INTERVAL_SECONDS
 * values. The scheduler dispatcher polls every 60 seconds, so the
 * effective firing resolution is 60 seconds regardless of what's stored.
 * A row with `interval_seconds = 30` fires every poll cycle (every 60s),
 * not every 30s -- silent under-firing. The UI minimum is 1 minute so UI
 * traffic never hits this path; only API / DB-direct writes can land
 * sub-60s values. Throwing (rather than returning null) forces callers
 * to surface a 400 to the user instead of silently demoting the
 * schedule to the cron path.
 */
export const MIN_INTERVAL_SECONDS = 60;

export class IntervalTooSmallError extends Error {
  readonly raw: number;
  readonly minimum: number;
  constructor(raw: number) {
    super(
      `scheduleIntervalSeconds must be >= ${MIN_INTERVAL_SECONDS} (got ${raw})`
    );
    this.name = "IntervalTooSmallError";
    this.raw = raw;
    this.minimum = MIN_INTERVAL_SECONDS;
  }
}

export function parseIntervalSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const floored = Math.floor(n);
  if (floored < MIN_INTERVAL_SECONDS) {
    throw new IntervalTooSmallError(floored);
  }
  return floored;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type SimpleFrequency =
  | "every-minute"
  | "every-n-minutes"
  | "hourly"
  | "daily"
  | "weekly";

export type SimpleSchedule = {
  frequency: SimpleFrequency;
  interval?: number;
  minute?: number;
  hour?: number;
  daysOfWeek?: number[];
};

/**
 * Validate a cron expression using cron-parser
 */
export function validateCronExpression(cronExpression: string): {
  valid: boolean;
  error?: string;
} {
  if (!cronExpression || typeof cronExpression !== "string") {
    return { valid: false, error: "Cron expression is required" };
  }

  const parts = cronExpression.trim().split(CRON_FIELD_SPLITTER);
  if (parts.length < 5 || parts.length > 6) {
    return {
      valid: false,
      error: "Cron expression must have 5 or 6 fields",
    };
  }

  try {
    CronExpressionParser.parse(cronExpression);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid cron expression",
    };
  }
}

/**
 * Build a cron expression string from simple schedule state
 */
export function buildCronFromSimple(state: SimpleSchedule): string {
  switch (state.frequency) {
    case "every-minute":
      return "* * * * *";
    case "every-n-minutes":
      return `*/${state.interval ?? 5} * * * *`;
    case "hourly":
      return `${state.minute ?? 0} * * * *`;
    case "daily":
      return `${state.minute ?? 0} ${state.hour ?? 9} * * *`;
    case "weekly": {
      const days =
        state.daysOfWeek !== undefined && state.daysOfWeek.length > 0
          ? state.daysOfWeek.join(",")
          : "*";
      return `${state.minute ?? 0} ${state.hour ?? 9} * * ${days}`;
    }
    default:
      return "* * * * *";
  }
}

/**
 * Parse a single numeric cron field. Returns null if not a plain integer.
 */
function parseNumericField(field: string): number | null {
  const num = Number.parseInt(field, 10);
  if (Number.isNaN(num) || String(num) !== field) {
    return null;
  }
  return num;
}

/**
 * Try to match interval patterns like * * * * * or *\/N * * * *
 */
function parseWildcardMinute(
  minuteField: string,
  hourField: string,
  dayOfWeek: string
): SimpleSchedule | null {
  if (minuteField === "*" && hourField === "*" && dayOfWeek === "*") {
    return { frequency: "every-minute" };
  }

  const intervalMatch = minuteField.match(INTERVAL_PATTERN);
  if (intervalMatch !== null && hourField === "*" && dayOfWeek === "*") {
    return {
      frequency: "every-n-minutes",
      interval: Number.parseInt(intervalMatch[1], 10),
    };
  }

  return null;
}

/**
 * Attempt to parse a cron string into a SimpleSchedule.
 * Returns null if the expression cannot be represented in simple mode.
 */
export function parseCronToSimple(cron: string): SimpleSchedule | null {
  if (!cron) {
    return null;
  }

  const parts = cron.trim().split(CRON_FIELD_SPLITTER);
  if (parts.length !== 5) {
    return null;
  }

  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth !== "*" || month !== "*") {
    return null;
  }

  const wildcardResult = parseWildcardMinute(minuteField, hourField, dayOfWeek);
  if (wildcardResult !== null) {
    return wildcardResult;
  }

  const minuteNum = parseNumericField(minuteField);
  if (minuteNum === null) {
    return null;
  }

  if (hourField === "*" && dayOfWeek === "*") {
    return { frequency: "hourly", minute: minuteNum };
  }

  const hourNum = parseNumericField(hourField);
  if (hourNum === null) {
    return null;
  }

  if (dayOfWeek === "*") {
    return { frequency: "daily", minute: minuteNum, hour: hourNum };
  }

  const days = parseDaysOfWeek(dayOfWeek);
  if (days === null) {
    return null;
  }

  return {
    frequency: "weekly",
    minute: minuteNum,
    hour: hourNum,
    daysOfWeek: days,
  };
}

/**
 * Parse a single day-of-week token (number or range like "1-5").
 * Returns the day numbers or null if invalid.
 */
function parseDayToken(token: string): number[] | null {
  const rangeMatch = token.match(RANGE_PATTERN);
  if (rangeMatch === null) {
    const num = parseNumericField(token);
    if (num === null || num > 6) {
      return null;
    }
    return [num];
  }

  const start = Number.parseInt(rangeMatch[1], 10);
  const end = Number.parseInt(rangeMatch[2], 10);
  if (start > 6 || end > 6 || start > end) {
    return null;
  }

  const result: number[] = [];
  for (let i = start; i <= end; i++) {
    result.push(i);
  }
  return result;
}

/**
 * Parse a day-of-week field into an array of day numbers (0-6).
 * Supports comma-separated values and ranges (e.g. "1,3,5" or "1-5").
 */
function parseDaysOfWeek(field: string): number[] | null {
  const days: number[] = [];

  for (const part of field.split(",")) {
    const parsed = parseDayToken(part);
    if (parsed === null) {
      return null;
    }
    days.push(...parsed);
  }

  return days.length > 0 ? days : null;
}

/**
 * Format time from 24h to 12h AM/PM
 */
function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  let displayHour = hour;
  if (hour === 0) {
    displayHour = 12;
  } else if (hour > 12) {
    displayHour = hour - 12;
  }
  const displayMinute = String(minute).padStart(2, "0");
  return `${displayHour}:${displayMinute} ${period}`;
}

/**
 * Generate a human-readable description of a cron expression
 */
export function describeCron(cron: string): string {
  if (!cron) {
    return "";
  }

  const simple = parseCronToSimple(cron);
  if (simple !== null) {
    return describeSimple(simple);
  }

  // Fallback: validate and show generic message
  const validation = validateCronExpression(cron);
  if (!validation.valid) {
    return "";
  }

  return "Custom schedule";
}

function describeSimple(s: SimpleSchedule): string {
  switch (s.frequency) {
    case "every-minute":
      return "Every minute";
    case "every-n-minutes": {
      // KEEP-575: `*/N * * * *` in 5-field cron means "minutes divisible
      // by N within each hour", which only equals "every N minutes" when
      // N divides 60. For other N the cron fires twice per hour with
      // uneven gaps — be honest about that here.
      const n = s.interval ?? 0;
      if (n > 0 && 60 % n === 0) {
        return `Every ${n} minutes`;
      }
      return `At minute 0 and every ${n} minutes within each hour (uneven gaps)`;
    }
    case "hourly":
      return s.minute === 0
        ? "Every hour on the hour"
        : `Every hour at minute ${s.minute}`;
    case "daily":
      return `Every day at ${formatTime(s.hour ?? 9, s.minute ?? 0)}`;
    case "weekly": {
      const days = s.daysOfWeek ?? [];
      const time = formatTime(s.hour ?? 9, s.minute ?? 0);

      // Check for weekday range
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
        return `Every weekday at ${time}`;
      }

      if (days.length === 1) {
        return `Every ${DAY_NAMES[days[0]]} at ${time}`;
      }

      const dayNames = days.map((d) => DAY_NAMES[d]).join(", ");
      return `Every ${dayNames} at ${time}`;
    }
    default:
      return "Custom schedule";
  }
}
