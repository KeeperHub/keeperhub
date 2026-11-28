import { logWarn } from "@/lib/logging";

const DEFAULT_THRESHOLD_MINUTES = 30;
const MIN_THRESHOLD_MINUTES = 1;
// A day at most: longer would let a crashed run block a skip-if-running trigger for days.
const MAX_THRESHOLD_MINUTES = 24 * 60;
const DIGITS = /^\d+$/;

let warnedFor: string | undefined;

function warnOnce(raw: string, used: number): void {
  if (warnedFor === raw) {
    return;
  }
  warnedFor = raw;
  logWarn("[Reaper] STALE_EXECUTION_THRESHOLD_MINUTES out of range", {
    value: raw,
    used: String(used),
  });
}

/** Minutes after which a running execution counts as stuck (STALE_EXECUTION_THRESHOLD_MINUTES, 1 to 1440, default 30). */
export function staleExecutionThresholdMinutes(): number {
  const raw = process.env.STALE_EXECUTION_THRESHOLD_MINUTES?.trim();
  if (!raw) {
    return DEFAULT_THRESHOLD_MINUTES;
  }
  const parsed = DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_THRESHOLD_MINUTES) {
    warnOnce(raw, DEFAULT_THRESHOLD_MINUTES);
    return DEFAULT_THRESHOLD_MINUTES;
  }
  const clamped = Math.min(MAX_THRESHOLD_MINUTES, parsed);
  if (clamped !== parsed) {
    warnOnce(raw, clamped);
  }
  return clamped;
}
