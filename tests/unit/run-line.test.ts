import { describe, expect, it } from "vitest";

import {
  exactDuration,
  parseDurationMs,
  runLineSpoken,
  runLineTitle,
  runLineTitleParts,
  shortDuration,
  shortTimeAgo,
  spokenDuration,
  spokenTimeAgo,
  stepCountLabel,
} from "@/lib/workflow/run-line";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const WHITESPACE = /\s/g;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("shortTimeAgo", () => {
  it.each([
    [0, "just now"],
    [999, "just now"],
    [59 * SECOND, "just now"],
    [60 * SECOND, "1m ago"],
    [52 * MINUTE, "52m ago"],
    [59 * MINUTE + 59 * SECOND, "59m ago"],
    [HOUR, "1h ago"],
    [3 * HOUR, "3h ago"],
    [23 * HOUR + 59 * MINUTE, "23h ago"],
    [DAY, "1d ago"],
    [6 * DAY, "6d ago"],
    [7 * DAY, "1w ago"],
    [27 * DAY, "3w ago"],
    [28 * DAY, "1mo ago"],
    [29 * DAY, "1mo ago"],
    [60 * DAY, "2mo ago"],
    [330 * DAY, "11mo ago"],
    [360 * DAY, "1y ago"],
    [364 * DAY, "1y ago"],
    [365 * DAY, "1y ago"],
    [800 * DAY, "2y ago"],
  ])("%i ms ago reads %s", (ms, expected) => {
    expect(shortTimeAgo(ago(ms), NOW)).toBe(expected);
  });

  it("reads a start in the future (clock skew) as just now", () => {
    expect(shortTimeAgo(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe(
      "just now"
    );
  });

  it("takes an ISO string as the API sends it", () => {
    expect(shortTimeAgo(ago(2 * DAY).toISOString(), NOW)).toBe("2d ago");
  });
});

describe("shortDuration", () => {
  it.each([
    [0, "0ms"],
    [850, "850ms"],
    [999, "999ms"],
    [SECOND, "1s"],
    [40 * SECOND, "40s"],
    [59 * SECOND + 999, "59s"],
    [MINUTE, "1m 00s"],
    [2 * MINUTE + 5 * SECOND, "2m 05s"],
    [59 * MINUTE + 59 * SECOND, "59m 59s"],
    [HOUR, "1h 00m"],
    [HOUR + 5 * MINUTE, "1h 05m"],
    [26 * HOUR, "26h 00m"],
  ])("%i ms reads %s", (ms, expected) => {
    expect(shortDuration(ms)).toBe(expected);
  });

  it("never shows a negative duration", () => {
    expect(shortDuration(-5)).toBe("0ms");
  });
});

describe("exactDuration", () => {
  it.each([
    [850, "850ms"],
    [SECOND, "1.00s"],
    [40 * SECOND, "40.00s"],
    [125_430, "125.43s"],
    [59 * MINUTE + 59 * SECOND + 999, "3599.99s"],
    [HOUR, "1h 00m 00s"],
    [HOUR + 5 * MINUTE, "1h 05m 00s"],
    [3 * HOUR + 2 * MINUTE + 7 * SECOND + 500, "3h 02m 07s"],
  ])("%i ms reads %s", (ms, expected) => {
    expect(exactDuration(ms)).toBe(expected);
  });
});

describe("stepCountLabel", () => {
  it.each([
    [1, "1 step"],
    [2, "2 steps"],
    [0, "0 steps"],
  ])("%i reads %s", (count, expected) => {
    expect(stepCountLabel(count)).toBe(expected);
  });
});

describe("parseDurationMs", () => {
  it("reads the duration column's text as milliseconds", () => {
    expect(parseDurationMs("40210")).toBe(40_210);
    expect(parseDurationMs("0")).toBe(0);
  });

  it("is null without a usable duration", () => {
    expect(parseDurationMs(null)).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();
  });
});

describe("runLineTitle", () => {
  const startedAt = "2026-11-27T08:54:00.000Z";
  const GB_UTC = { locale: "en-GB", timeZone: "UTC" };

  it("writes the date in the viewer's locale and names the time zone", () => {
    const title = runLineTitle(
      { startedAt, durationMs: null, stepCount: 0 },
      { locale: "en-US", timeZone: "America/New_York" }
    );
    // ICU may put a narrow no-break space before AM.
    expect(title.replace(WHITESPACE, " ")).toBe(
      "Started Nov 27, 2026, 03:54 AM EST"
    );
  });

  it("gives an hour-long run's exact duration in hours, minutes and seconds", () => {
    expect(
      runLineTitle(
        { startedAt, durationMs: HOUR + 5 * MINUTE, stepCount: 3 },
        GB_UTC
      )
    ).toBe("Started 27 Nov 2026, 08:54 UTC · ran 1h 05m 00s · 3 steps");
  });

  it("gives the full date, the exact duration and the step count", () => {
    expect(
      runLineTitle({ startedAt, durationMs: 40_000, stepCount: 2 }, GB_UTC)
    ).toBe("Started 27 Nov 2026, 08:54 UTC · ran 40.00s · 2 steps");
  });

  it("splits into the parts the opened run keeps whole on wrap", () => {
    expect(
      runLineTitleParts({ startedAt, durationMs: 40_000, stepCount: 2 }, GB_UTC)
    ).toEqual(["Started 27 Nov 2026, 08:54 UTC", "ran 40.00s", "2 steps"]);
  });

  it("leaves out what a run does not have yet", () => {
    expect(
      runLineTitle({ startedAt, durationMs: null, stepCount: 0 }, GB_UTC)
    ).toBe("Started 27 Nov 2026, 08:54 UTC");
    expect(
      runLineTitle({ startedAt, durationMs: 850, stepCount: 1 }, GB_UTC)
    ).toBe("Started 27 Nov 2026, 08:54 UTC · ran 850ms · 1 step");
  });
});

describe("spoken forms", () => {
  it.each([
    [30 * SECOND, "just now"],
    [MINUTE, "1 minute ago"],
    [52 * MINUTE, "52 minutes ago"],
    [HOUR, "1 hour ago"],
    [2 * DAY, "2 days ago"],
    [14 * DAY, "2 weeks ago"],
    [60 * DAY, "2 months ago"],
    [800 * DAY, "2 years ago"],
  ])("%i ms ago is said %s", (ms, expected) => {
    expect(spokenTimeAgo(ago(ms), NOW)).toBe(expected);
  });

  it.each([
    [850, "850 milliseconds"],
    [SECOND, "1 second"],
    [40 * SECOND, "40 seconds"],
    [MINUTE, "1 minute"],
    [2 * MINUTE + 5 * SECOND, "2 minutes 5 seconds"],
    [HOUR, "1 hour"],
    [HOUR + MINUTE, "1 hour 1 minute"],
  ])("%i ms is said %s", (ms, expected) => {
    expect(spokenDuration(ms)).toBe(expected);
  });

  it("says the whole line without abbreviations", () => {
    expect(
      runLineSpoken(
        { startedAt: ago(52 * MINUTE), durationMs: 40_000, stepCount: 2 },
        NOW
      )
    ).toBe("52 minutes ago, ran 40 seconds, 2 steps");
    expect(
      runLineSpoken({ startedAt: ago(0), durationMs: null, stepCount: 0 }, NOW)
    ).toBe("just now");
  });
});
