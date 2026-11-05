import { describe, expect, it } from "vitest";
import { REFUSED_RUNS_THRESHOLD } from "@/lib/notifications/failure-alerts/constants";
import { refusalSummary } from "@/lib/workflow/refusal-summary";

const run = {
  status: "skipped",
  refusals: 12,
  startedAt: "2026-11-05T10:05:00Z",
  completedAt: "2026-11-05T10:40:00Z",
};

describe("refusalSummary", () => {
  it("names the count and the first and last refusal in the viewer's zone", () => {
    expect(refusalSummary(run, { locale: "en-GB", timeZone: "UTC" })).toBe(
      "Refused at least 12 times between 10:05 and 10:40"
    );
    expect(
      refusalSummary(run, { locale: "en-GB", timeZone: "Europe/Bucharest" })
    ).toBe("Refused at least 12 times between 12:05 and 12:40");
  });

  it("says at least from the threshold on, where the row is throttled", () => {
    expect(
      refusalSummary(
        { ...run, refusals: REFUSED_RUNS_THRESHOLD },
        { locale: "en-GB", timeZone: "UTC" }
      )
    ).toBe(
      `Refused at least ${REFUSED_RUNS_THRESHOLD} times between 10:05 and 10:40`
    );
  });

  it("says nothing for one refusal, a row without a count, or a run that is not skipped", () => {
    expect(refusalSummary({ ...run, refusals: 1 })).toBeNull();
    expect(refusalSummary({ ...run, refusals: null })).toBeNull();
    expect(refusalSummary({ ...run, completedAt: null })).toBeNull();
    expect(refusalSummary({ ...run, status: "error" })).toBeNull();
  });
});
