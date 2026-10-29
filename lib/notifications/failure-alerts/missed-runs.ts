import { CronExpressionParser } from "cron-parser";
import { MISSED_RUN_GRACE_MS } from "./constants";

/** A run may start this much before its due time (dispatcher clock, phantom row). */
const DISPATCH_TOLERANCE_MS = 60 * 1000;

type ScheduleTiming = {
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

const MIN_GRACE_MS = 2 * 60 * 1000;

/** How late a run may be: twice its interval, between 2 and 10 minutes. */
export function graceFor(schedule: ScheduleTiming, at: Date): number {
  let interval: number | null = null;
  if (schedule.intervalSeconds && schedule.intervalSeconds > 0) {
    interval = schedule.intervalSeconds * 1000;
  } else {
    try {
      const cron = CronExpressionParser.parse(schedule.cronExpression, {
        currentDate: at,
        tz: schedule.timezone,
      });
      interval = cron.next().getTime() - cron.prev().getTime();
    } catch {
      interval = null;
    }
  }
  if (!interval || interval <= 0) {
    return MISSED_RUN_GRACE_MS;
  }
  return Math.min(MISSED_RUN_GRACE_MS, Math.max(MIN_GRACE_MS, 2 * interval));
}

/** The first time the schedule is due strictly after `after`. */
export function nextDueAfter(
  schedule: ScheduleTiming,
  after: Date
): Date | null {
  const { intervalSeconds, anchorAt } = schedule;
  if (intervalSeconds && intervalSeconds > 0 && anchorAt) {
    const step = intervalSeconds * 1000;
    const k = Math.floor((after.getTime() - anchorAt.getTime()) / step) + 1;
    return new Date(anchorAt.getTime() + Math.max(k, 1) * step);
  }
  try {
    return CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: after,
      tz: schedule.timezone,
    })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** The first run it missed (due past the grace, after notBefore and the last run), or null. */
export function missedDueAt(params: {
  schedule: ScheduleTiming;
  lastStartedAt: Date | null;
  notBefore: Date;
  now: Date;
}): Date | null {
  const latest = lastDueAt(
    params.schedule,
    new Date(params.now.getTime() - graceFor(params.schedule, params.now))
  );
  if (!latest || latest <= params.notBefore) {
    return null;
  }
  // A run up to the tolerance early still counts for that due time.
  const ranUpTo = params.lastStartedAt
    ? params.lastStartedAt.getTime() + DISPATCH_TOLERANCE_MS
    : Number.NEGATIVE_INFINITY;
  const first = nextDueAfter(
    params.schedule,
    new Date(Math.max(params.notBefore.getTime(), ranUpTo))
  );
  return first && first <= latest ? first : null;
}

/** Runs started after this cannot leave a missed run behind, so the query skips them. */
export function ranRecentlyCutoff(now: Date): Date {
  return new Date(now.getTime() - MISSED_RUN_GRACE_MS - DISPATCH_TOLERANCE_MS);
}
