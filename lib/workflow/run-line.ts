// Short wording for a run card's info line ("52m ago · 40s · 2 steps"),
// with the exact values for its tooltip and a spoken form for screen readers.

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

type AgoUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

const SHORT_AGO_UNIT: Record<AgoUnit, string> = {
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// How long ago, in the largest whole unit; null under a minute.
function timeAgoParts(
  date: string | Date,
  now: Date
): { count: number; unit: AgoUnit } | null {
  const seconds = Math.floor((now.getTime() - new Date(date).getTime()) / 1000);
  if (seconds < 60) {
    return null;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return { count: minutes, unit: "minute" };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { count: hours, unit: "hour" };
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return { count: days, unit: "day" };
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 4) {
    return { count: weeks, unit: "week" };
  }
  const months = Math.max(1, Math.floor(days / 30));
  if (months < 12) {
    return { count: months, unit: "month" };
  }
  return { count: Math.max(1, Math.floor(days / 365)), unit: "year" };
}

/** "just now", "52m ago", "3h ago", "2d ago", "3w ago", "5mo ago", "1y ago". */
export function shortTimeAgo(
  date: string | Date,
  now: Date = new Date()
): string {
  const parts = timeAgoParts(date, now);
  return parts === null
    ? "just now"
    : `${parts.count}${SHORT_AGO_UNIT[parts.unit]} ago`;
}

/** "just now", "52 minutes ago", "1 hour ago", for screen readers. */
export function spokenTimeAgo(
  date: string | Date,
  now: Date = new Date()
): string {
  const parts = timeAgoParts(date, now);
  return parts === null ? "just now" : `${plural(parts.count, parts.unit)} ago`;
}

/** "850ms", "40s", "2m 05s", "1h 05m". */
export function shortDuration(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  if (whole < SECOND_MS) {
    return `${whole}ms`;
  }
  if (whole < MINUTE_MS) {
    return `${Math.floor(whole / SECOND_MS)}s`;
  }
  if (whole < HOUR_MS) {
    const seconds = Math.floor((whole % MINUTE_MS) / SECOND_MS);
    return `${Math.floor(whole / MINUTE_MS)}m ${twoDigits(seconds)}s`;
  }
  const minutes = Math.floor((whole % HOUR_MS) / MINUTE_MS);
  return `${Math.floor(whole / HOUR_MS)}h ${twoDigits(minutes)}m`;
}

/** "850 milliseconds", "40 seconds", "2 minutes 5 seconds", "1 hour 5 minutes". */
export function spokenDuration(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  if (whole < SECOND_MS) {
    return plural(whole, "millisecond");
  }
  if (whole < MINUTE_MS) {
    return plural(Math.floor(whole / SECOND_MS), "second");
  }
  const underHour = whole < HOUR_MS;
  const bigMs = underHour ? MINUTE_MS : HOUR_MS;
  const smallMs = underHour ? SECOND_MS : MINUTE_MS;
  const head = plural(Math.floor(whole / bigMs), underHour ? "minute" : "hour");
  const small = Math.floor((whole % bigMs) / smallMs);
  return small === 0
    ? head
    : `${head} ${plural(small, underHour ? "second" : "minute")}`;
}

/** "850ms" or "40.00s" under an hour; "1h 05m 00s" from an hour. */
export function exactDuration(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  if (whole < SECOND_MS) {
    return `${whole}ms`;
  }
  if (whole < HOUR_MS) {
    // Cut, not rounded, so just under an hour never reads "3600.00s".
    return `${(Math.floor(whole / 10) / 100).toFixed(2)}s`;
  }
  const minutes = Math.floor((whole % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((whole % MINUTE_MS) / SECOND_MS);
  return `${Math.floor(whole / HOUR_MS)}h ${twoDigits(minutes)}m ${twoDigits(seconds)}s`;
}

export function stepCountLabel(count: number): string {
  return plural(count, "step");
}

/** A run's duration column (milliseconds as text) as a number, or null. */
export function parseDurationMs(duration: string | null): number | null {
  if (duration === null) {
    return null;
  }
  const parsed = Number.parseInt(duration, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

type RunLine = {
  startedAt: string | Date;
  durationMs: number | null;
  stepCount: number | null;
};

/** The start time in the viewer's locale, with its time zone. */
export function runStartedAt(
  startedAt: string | Date,
  options: { locale?: string; timeZone?: string } = {}
): string {
  return new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
    timeZoneName: "short",
  }).format(new Date(startedAt));
}

/** ["Started 27 Nov 2026, 08:54 UTC", "ran 40.00s", "2 steps"]: exact values. */
export function runLineTitleParts(
  run: RunLine,
  options: { locale?: string; timeZone?: string } = {}
): string[] {
  const parts = [`Started ${runStartedAt(run.startedAt, options)}`];
  if (run.durationMs !== null) {
    parts.push(`ran ${exactDuration(run.durationMs)}`);
  }
  if (run.stepCount !== null && run.stepCount > 0) {
    parts.push(stepCountLabel(run.stepCount));
  }
  return parts;
}

/** "Started 27 Nov 2026, 08:54 UTC · ran 40.00s · 2 steps". */
export function runLineTitle(
  run: RunLine,
  options: { locale?: string; timeZone?: string } = {}
): string {
  return runLineTitleParts(run, options).join(" · ");
}

/** "52 minutes ago, ran 40 seconds, 2 steps", the line as a screen reader says it. */
export function runLineSpoken(run: RunLine, now: Date = new Date()): string {
  const parts = [spokenTimeAgo(run.startedAt, now)];
  if (run.durationMs !== null) {
    parts.push(`ran ${spokenDuration(run.durationMs)}`);
  }
  if (run.stepCount !== null && run.stepCount > 0) {
    parts.push(stepCountLabel(run.stepCount));
  }
  return parts.join(", ");
}
