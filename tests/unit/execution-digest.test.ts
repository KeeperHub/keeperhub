import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {},
  workflows: {},
}));

import {
  digestWindow,
  isDigestDue,
} from "@/lib/notifications/execution-digest";

// 2026-06-02 is a Tuesday (UTC); 2026-06-04 is a Thursday (a non-digest day);
// 2026-06-01 is the 1st of the month (the monthly-digest day).
const TUESDAY = new Date("2026-06-02T14:00:00.000Z");
const THURSDAY = new Date("2026-06-04T14:00:00.000Z");
const FIRST_OF_MONTH = new Date("2026-06-01T14:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function minus(base: Date, ms: number): Date {
  return new Date(base.getTime() - ms);
}

describe("isDigestDue daily", () => {
  it("is due when never sent", () => {
    expect(isDigestDue("daily", null, TUESDAY)).toBe(true);
  });

  it("is due ~24h later, not shortly after", () => {
    expect(isDigestDue("daily", minus(TUESDAY, DAY), TUESDAY)).toBe(true);
    expect(isDigestDue("daily", minus(TUESDAY, 2 * HOUR), TUESDAY)).toBe(false);
  });

  it("tolerates a slightly-early cron firing (>= 23h)", () => {
    expect(isDigestDue("daily", minus(TUESDAY, 23 * HOUR), TUESDAY)).toBe(true);
    expect(isDigestDue("daily", minus(TUESDAY, 22 * HOUR), TUESDAY)).toBe(
      false
    );
  });
});

describe("isDigestDue weekly (Tuesday-pinned)", () => {
  it("is due on Tuesday when never sent", () => {
    expect(isDigestDue("weekly", null, TUESDAY)).toBe(true);
  });

  it("is not due on a non-Tuesday, even after a week", () => {
    expect(isDigestDue("weekly", null, THURSDAY)).toBe(false);
    expect(isDigestDue("weekly", minus(THURSDAY, 8 * DAY), THURSDAY)).toBe(
      false
    );
  });

  it("is due again the next Tuesday", () => {
    expect(isDigestDue("weekly", minus(TUESDAY, 7 * DAY), TUESDAY)).toBe(true);
  });

  it("does not re-send twice on the same Tuesday", () => {
    expect(isDigestDue("weekly", minus(TUESDAY, 3 * HOUR), TUESDAY)).toBe(
      false
    );
  });
});

describe("isDigestDue monthly (1st-pinned)", () => {
  it("is due on the 1st when never sent", () => {
    expect(isDigestDue("monthly", null, FIRST_OF_MONTH)).toBe(true);
  });

  it("is not due on a non-1st day", () => {
    expect(isDigestDue("monthly", null, TUESDAY)).toBe(false);
    expect(isDigestDue("monthly", minus(TUESDAY, 40 * DAY), TUESDAY)).toBe(
      false
    );
  });

  it("does not re-send twice on the same 1st", () => {
    expect(
      isDigestDue("monthly", minus(FIRST_OF_MONTH, 3 * HOUR), FIRST_OF_MONTH)
    ).toBe(false);
  });
});

describe("digestWindow", () => {
  it("returns a rolling 24h window ending now for daily", () => {
    const { since, until } = digestWindow("daily", TUESDAY);
    expect(since.toISOString()).toBe("2026-06-01T14:00:00.000Z");
    expect(until.toISOString()).toBe("2026-06-02T14:00:00.000Z");
  });

  it("returns a rolling 7d window ending now for weekly", () => {
    const { since, until } = digestWindow("weekly", TUESDAY);
    expect(since.toISOString()).toBe("2026-05-26T14:00:00.000Z");
    expect(until.toISOString()).toBe("2026-06-02T14:00:00.000Z");
  });

  it("returns the previous full calendar month for monthly", () => {
    const { since, until } = digestWindow("monthly", FIRST_OF_MONTH);
    expect(since.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});
