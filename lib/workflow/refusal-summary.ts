// Client-safe text for a refused run's hourly row (see refused-runs.ts).

type RefusedRunFields = {
  status: string;
  refusals: number | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
};

/** "Refused 12 times between 10:05 and 10:40", in the viewer's time zone; null for a single refusal. */
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
  return `Refused ${run.refusals} times between ${time(run.startedAt)} and ${time(run.completedAt)}`;
}
