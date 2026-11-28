// How the editor and run views show a unix time: in the viewer's own time zone.

type ZoneOption = { timeZone?: string };

function dateOf(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** "1 Dec 2026, 13:00:00", the date and time without the zone. */
export function formatDateTime(seconds: number, options?: ZoneOption): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: options?.timeZone,
  }).format(dateOf(seconds));
}

/** "1 Dec 2026, 13:00:00 CET", the full date with its zone, for tooltips and expanded text. */
export function formatDateTimeWithZone(
  seconds: number,
  options?: ZoneOption
): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone: options?.timeZone,
  }).format(dateOf(seconds));
}

function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

function clock(date: Date, withSeconds: boolean, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds && { second: "2-digit" }),
    hourCycle: "h23",
    timeZone,
  }).format(date);
}

/**
 * A short time, "13:00", with the date ("Dec 1, 13:00") only when it is not
 * the same day as `now`. `withSeconds` gives "13:00:36".
 */
export function formatShortTime(
  seconds: number,
  options: ZoneOption & { now: Date; withSeconds?: boolean }
): string {
  const date = dateOf(seconds);
  const time = clock(date, options.withSeconds === true, options.timeZone);
  if (
    dayKey(date, options.timeZone) === dayKey(options.now, options.timeZone)
  ) {
    return time;
  }
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: options.timeZone,
  }).format(date);
  return `${day}, ${time}`;
}
