import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type CoveredInterval,
  calendarWindowToRecord,
  predatesProviderCycles,
  type SubscriptionPlanRow,
  uncoveredPart,
} from "@/lib/billing/execution-usage-periods";

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function sub(plan: SubscriptionPlanRow["plan"]): SubscriptionPlanRow {
  return {
    plan,
    tier: null,
    planOverrides: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  };
}

const DECEMBER_START = utc(2025, 12, 1);
const DECEMBER_END = utc(2026, 1, 1);

describe("uncoveredPart", () => {
  // Two cycles that meet on Dec 10. Together they cover the month up to
  // Dec 20, so Dec 20 onwards is the part nobody billed.
  const earlier: CoveredInterval = {
    start: utc(2025, 11, 10),
    end: utc(2025, 12, 10),
  };
  const later: CoveredInterval = {
    start: utc(2025, 12, 10),
    end: utc(2025, 12, 20),
  };
  const uncovered = { periodStart: utc(2025, 12, 20), periodEnd: DECEMBER_END };

  it("finds the days after two adjacent cycles", () => {
    expect(
      uncoveredPart(DECEMBER_START, DECEMBER_END, [earlier, later])
    ).toEqual(uncovered);
  });

  it("gives the same answer when the later cycle comes first", () => {
    // Read later-first, the second cycle closes the window at Dec 10 and the
    // first then covers all that is left, so the result used to be null.
    expect(
      uncoveredPart(DECEMBER_START, DECEMBER_END, [later, earlier])
    ).toEqual(uncovered);
  });

  it("does not reorder the caller's list", () => {
    const covered = [later, earlier];
    uncoveredPart(DECEMBER_START, DECEMBER_END, covered);
    expect(covered).toEqual([later, earlier]);
  });

  it("returns null when the cycles cover the window between them", () => {
    const rest: CoveredInterval = {
      start: utc(2025, 12, 20),
      end: DECEMBER_END,
    };
    expect(
      uncoveredPart(DECEMBER_START, DECEMBER_END, [rest, later, earlier])
    ).toBeNull();
  });

  it("treats a cycle that starts on the window end as outside it", () => {
    const next: CoveredInterval = { start: DECEMBER_END, end: utc(2026, 2, 1) };
    expect(uncoveredPart(DECEMBER_START, DECEMBER_END, [next])).toEqual({
      periodStart: DECEMBER_START,
      periodEnd: DECEMBER_END,
    });
  });
});

describe("predatesProviderCycles", () => {
  it("is false with no cycle to compare against", () => {
    expect(
      predatesProviderCycles(
        { periodStart: DECEMBER_START, periodEnd: DECEMBER_END },
        []
      )
    ).toBe(false);
  });

  it("is true for a window that ends on the instant the earliest cycle starts", () => {
    expect(
      predatesProviderCycles(
        { periodStart: DECEMBER_START, periodEnd: utc(2025, 12, 10) },
        [{ start: utc(2025, 12, 10), end: utc(2026, 1, 10) }]
      )
    ).toBe(true);
  });
});

describe("calendarWindowToRecord", () => {
  const cycle: CoveredInterval = {
    start: utc(2025, 12, 10),
    end: utc(2025, 12, 20),
  };
  const before = { periodStart: DECEMBER_START, periodEnd: cycle.start };

  it("gives a paid plan the days before its earliest cycle", () => {
    expect(
      calendarWindowToRecord(DECEMBER_START, DECEMBER_END, [cycle], sub("pro"))
    ).toEqual(before);
  });

  it("gives a paid plan nothing after a cycle it already had", () => {
    // The days after the cycle do not predate it, so they are the billing
    // path's and a zero-charge month row would contradict the plan.
    expect(
      calendarWindowToRecord(cycle.end, DECEMBER_END, [cycle], sub("pro"))
    ).toBeNull();
  });

  it("gives a plan that does not bill overage every uncovered day", () => {
    const after = { periodStart: cycle.end, periodEnd: DECEMBER_END };
    expect(
      calendarWindowToRecord(cycle.end, DECEMBER_END, [cycle], sub("free"))
    ).toEqual(after);
    expect(
      calendarWindowToRecord(cycle.end, DECEMBER_END, [cycle], undefined)
    ).toEqual(after);
  });

  it("gives nobody a window a cycle covers completely", () => {
    const whole: CoveredInterval = { start: DECEMBER_START, end: DECEMBER_END };
    expect(
      calendarWindowToRecord(DECEMBER_START, DECEMBER_END, [whole], sub("free"))
    ).toBeNull();
  });
});
