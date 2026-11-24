// Client-safe text for a refused run's hourly row (see refused-runs.ts).

import { REFUSED_RUNS_THRESHOLD } from "@/lib/notifications/failure-alerts/constants";

type RefusedRunFields = {
  status: string;
  // output.refusals; a "previous run still running" row reuses it for its skip count (skip-if-running.ts).
  refusals: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
  /** Null on a skip that is not a refusal (previous run still running): once per block or slot, repeats within 2 minutes not counted. */
  errorCategory?: string | null;
};

/**
 * "Refused at least 12 times between 10:05 and 10:40" in the viewer's zone; null for one refusal.
 * From the threshold on, the row is rewritten at most once a minute, so the count is a lower bound.
 */
export function refusalSummary(
  run: RefusedRunFields,
  options: { locale?: string; timeZone?: string } = {}
): string | null {
  if (
    run.status !== "skipped" ||
    run.refusals === null ||
    run.refusals < 2 ||
    run.completedAt === null
  ) {
    return null;
  }
  const time = (value: Date | string): string =>
    new Date(value).toLocaleTimeString(options.locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: options.timeZone,
    });
  if (run.errorCategory === null) {
    return `Skipped ${run.refusals} times between ${time(run.startedAt)} and ${time(run.completedAt)}`;
  }
  const count =
    run.refusals >= REFUSED_RUNS_THRESHOLD
      ? `at least ${run.refusals}`
      : `${run.refusals}`;
  return `Refused ${count} times between ${time(run.startedAt)} and ${time(run.completedAt)}`;
}
