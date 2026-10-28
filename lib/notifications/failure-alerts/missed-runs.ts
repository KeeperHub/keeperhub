import { CronExpressionParser } from "cron-parser";
import { MISSED_RUN_GRACE_MS } from "./constants";

/** A run may start this much before its due time (dispatcher clock, phantom row). */
const DISPATCH_TOLERANCE_MS = 60 * 1000;

export type ScheduleTiming = {
  cronExpression: string;
  timezone: string;
  intervalSeconds: number | null;
  anchorAt: Date | null;
};

/** The latest time the schedule was due at or before `at`, the way the dispatcher counts. */
export function lastDueAt(schedule: ScheduleTiming, at: Date): Date | null {
  const { intervalSeconds, anchorAt } = schedule;
  if (intervalSeconds && intervalSeconds > 0 && anchorAt) {
    const step = intervalSeconds * 1000;
    const k = Math.floor((at.getTime() - anchorAt.getTime()) / step);
    return k >= 1 ? new Date(anchorAt.getTime() + k * step) : null;
  }
  try {
    return CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(at.getTime() + 1),
      tz: schedule.timezone,
    })
      .prev()
      .toDate();
  } catch {
    return null;
  }
}

/** When the run it missed was due, or null: due past the grace, after notBefore, and no run since. */
export function missedDueAt(params: {
  schedule: ScheduleTiming;
  lastStartedAt: Date | null;
  notBefore: Date;
  now: Date;
}): Date | null {
  const due = lastDueAt(
    params.schedule,
    new Date(params.now.getTime() - MISSED_RUN_GRACE_MS)
  );
  if (!due || due <= params.notBefore) {
    return null;
  }
  const ran =
    params.lastStartedAt !== null &&
    params.lastStartedAt.getTime() >= due.getTime() - DISPATCH_TOLERANCE_MS;
  return ran ? null : due;
}

/** Runs started after this cannot leave a missed run behind, so the query skips them. */
export function ranRecentlyCutoff(now: Date): Date {
  return new Date(now.getTime() - MISSED_RUN_GRACE_MS - DISPATCH_TOLERANCE_MS);
}
