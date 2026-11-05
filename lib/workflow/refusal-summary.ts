// Client-safe text for a refused run's hourly row (see refused-runs.ts).

import { REFUSED_RUNS_THRESHOLD } from "@/lib/notifications/failure-alerts/constants";

type RefusedRunFields = {
  status: string;
  refusals: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
};

/**
 * "Refused at least 12 times between 10:05 and 10:40", in the viewer's time zone;
 * null for a single refusal. From the threshold on, the row is rewritten at most
 * once a minute, so the count is a lower bound.
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
  const count =
    run.refusals >= REFUSED_RUNS_THRESHOLD
      ? `at least ${run.refusals}`
      : `${run.refusals}`;
  return `Refused ${count} times between ${time(run.startedAt)} and ${time(run.completedAt)}`;
}
