import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRelativeTime } from "@/lib/utils/time";

const NOW = new Date("2026-06-05T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("getRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for sub-minute differences", () => {
    expect(getRelativeTime(new Date(NOW.getTime() - 30 * 1000))).toBe(
      "just now"
    );
  });

  it("formats minutes, hours, days, and weeks", () => {
    expect(getRelativeTime(new Date(NOW.getTime() - 5 * 60 * 1000))).toBe(
      "5 mins ago"
    );
    expect(getRelativeTime(new Date(NOW.getTime() - 60 * 60 * 1000))).toBe(
      "1 hour ago"
    );
    expect(getRelativeTime(daysAgo(3))).toBe("3 days ago");
    expect(getRelativeTime(daysAgo(14))).toBe("2 weeks ago");
  });

  it("never reports 0 months in the week-to-month gap", () => {
    // 28-29 days fall past the <4 week branch but floor(days/30) === 0
    expect(getRelativeTime(daysAgo(28))).toBe("1 month ago");
    expect(getRelativeTime(daysAgo(29))).toBe("1 month ago");
  });

  it("formats whole months", () => {
    expect(getRelativeTime(daysAgo(60))).toBe("2 months ago");
  });

  it("never reports 0 years in the month-to-year gap", () => {
    // 360-364 days fall past the <12 month branch but floor(days/365) === 0
    expect(getRelativeTime(daysAgo(360))).toBe("1 year ago");
    expect(getRelativeTime(daysAgo(364))).toBe("1 year ago");
  });

  it("formats whole years", () => {
    expect(getRelativeTime(daysAgo(800))).toBe("2 years ago");
  });
});
