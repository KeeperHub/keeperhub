// A point in time as whole unix seconds, from a number, its decimal text or an
// ISO 8601 date with a zone. No imports: the step, save checks and editor share it.

/** The earliest and latest unix seconds a literal may be (2001-09-09 to 2286-11-20). */
export const MIN_UNIX_SECONDS = 1_000_000_000;
export const MAX_UNIX_SECONDS = 9_999_999_999;

const DIGITS_RE = /^\d+$/;
const LEADING_ZEROS_RE = /^0+(?=\d)/;
// Date, time with minutes (seconds and a fraction optional), then Z or an offset.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/;
// The same without a zone (the time optional), to suggest the UTC form.
const NO_ZONE_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;
// Digit counts of unix milliseconds, microseconds and nanoseconds, and their units per second.
const SUBSECOND_UNITS = new Map<number, { name: string; perSecond: bigint }>([
  [13, { name: "milliseconds", perSecond: BigInt(1000) }],
  [16, { name: "microseconds", perSecond: BigInt(1_000_000) }],
  [19, { name: "nanoseconds", perSecond: BigInt(1_000_000_000) }],
]);
// No real zone is more than 14 hours from UTC; a wider offset is a typo.
const MAX_OFFSET_MINUTES = 14 * 60;

export type UnixTimeRead =
  | { ok: true; seconds: number }
  // `reason` is a whole sentence the editor can show under the field.
  | { ok: false; reason: string };

const FORMAT_REASON =
  "Use unix seconds, such as 1796126400, or a date with a time zone, such as 2026-12-01T12:00:00Z.";

/**
 * `strict` (a literal saved in a config) keeps to MIN..MAX_UNIX_SECONDS. Not
 * strict returns the value as read, any size, for the caller to range-check.
 * Both refuse 13, 16 and 19 digits (milliseconds, microseconds, nanoseconds).
 */
export function readUnixTime(
  value: unknown,
  options: { strict: boolean }
): UnixTimeRead {
  let digits: string | undefined;
  if (typeof value === "bigint" && value >= BigInt(0)) {
    digits = value.toString();
  } else if (typeof value === "number") {
    if (!(Number.isInteger(value) && value >= 0)) {
      return { ok: false, reason: FORMAT_REASON };
    }
    // Past the safe range String() gives an exponent; any such value is far too late.
    digits = Number.isSafeInteger(value) ? String(value) : "9".repeat(20);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (DIGITS_RE.test(text)) {
      digits = text.replace(LEADING_ZEROS_RE, "");
    } else {
      return readIsoDate(text, options);
    }
  } else {
    return { ok: false, reason: FORMAT_REASON };
  }
  return readDigits(digits, options);
}

function readDigits(
  digits: string,
  options: { strict: boolean }
): UnixTimeRead {
  const unit = SUBSECOND_UNITS.get(digits.length);
  if (unit) {
    // Rounded up, so the suggestion is never early.
    const seconds =
      (BigInt(digits) + unit.perSecond - BigInt(1)) / unit.perSecond;
    return {
      ok: false,
      reason: `This looks like ${unit.name}. Use seconds: ${seconds}.`,
    };
  }
  return checkRange(Number(digits), options);
}

function checkRange(
  seconds: number,
  options: { strict: boolean }
): UnixTimeRead {
  if (
    options.strict &&
    (seconds < MIN_UNIX_SECONDS || seconds > MAX_UNIX_SECONDS)
  ) {
    return {
      ok: false,
      reason: `Use a time from ${MIN_UNIX_SECONDS} to ${MAX_UNIX_SECONDS} (unix seconds, 2001 to 2286).`,
    };
  }
  return { ok: true, seconds };
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(parts: number[]): boolean {
  const [year, month, day, hour, minute, second] = parts;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 && !leap ? 28 : DAYS_IN_MONTH[month - 1];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (monthDays ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function readIsoDate(text: string, options: { strict: boolean }): UnixTimeRead {
  const match = ISO_RE.exec(text);
  if (!match) {
    const noZone = NO_ZONE_RE.exec(text);
    if (noZone) {
      const [, date, hour = "00", minute = "00", second = "00"] = noZone;
      return {
        ok: false,
        reason: `Add a time zone, such as Z for UTC: ${date}T${hour}:${minute}:${second}Z.`,
      };
    }
    return { ok: false, reason: FORMAT_REASON };
  }
  const [, y, mo, d, h, mi, s = "0", fraction, zone] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  if (!isRealDate(parts)) {
    return { ok: false, reason: "This is not a real date and time." };
  }
  const [year, month, day, hour, minute, second] = parts;
  let offsetMinutes = 0;
  const offset = OFFSET_RE.exec(zone);
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const minutes = Number(offset[3]);
    offsetMinutes = sign * (Number(offset[2]) * 60 + minutes);
    if (minutes > 59 || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
      return {
        ok: false,
        reason:
          "This time zone offset is not real. Use one from -14:00 to +14:00.",
      };
    }
  }
  const utc =
    Date.UTC(year, month - 1, day, hour, minute, second) / 1000 -
    offsetMinutes * 60;
  // A fraction rounds up, so the time is never early.
  const fractional = fraction !== undefined && Number(fraction) > 0 ? 1 : 0;
  return checkRange(utc + fractional, options);
}
