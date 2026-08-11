// The PAYG billing period is the monthly window anchored to the enable date
// (`payg_config.started_at`) that contains "now" -- like a Stripe cycle anchored
// to signup. It is computed, not stored, so no roll cron is needed. All UTC.

export type PaygPeriod = { start: Date; end: Date };

/** Add whole months in UTC, clamping the day to the target month's length. */
function addMonthsUtc(date: Date, months: number): Date {
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

/** The monthly window anchored to `startedAt` that contains `now`. */
export function getPaygPeriod(
  startedAt: Date,
  now: Date = new Date()
): PaygPeriod {
  if (now < startedAt) {
    return { start: startedAt, end: addMonthsUtc(startedAt, 1) };
  }
  let k =
    (now.getUTCFullYear() - startedAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - startedAt.getUTCMonth());
  let start = addMonthsUtc(startedAt, k);
  if (now < start) {
    k -= 1;
    start = addMonthsUtc(startedAt, k);
  }
  let end = addMonthsUtc(startedAt, k + 1);
  if (now >= end) {
    start = end;
    end = addMonthsUtc(startedAt, k + 2);
  }
  return { start, end };
}

/** Start of the current UTC day (window for the daily spend cap). */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}
