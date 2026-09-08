import { describe, expect, it } from "vitest";
import { groupByDate } from "@/lib/activity/time-groups";

// Local-time strings (no "Z") so day bucketing is timezone-stable in CI.
const now = new Date("2026-06-10T12:00:00");
const iso = (s: string) => ({ at: s });

describe("groupByDate", () => {
  it("buckets into Today / Yesterday / This week / month, newest order preserved", () => {
    const items = [
      iso("2026-06-10T09:00:00"), // today
      iso("2026-06-10T01:00:00"), // today
      iso("2026-06-09T10:00:00"), // yesterday
      iso("2026-06-07T10:00:00"), // this week (3d ago)
      iso("2026-05-02T10:00:00"), // May 2026
    ];
    const groups = groupByDate(items, (i) => i.at, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "May 2026",
    ]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("returns an empty array for no items", () => {
    expect(groupByDate([], (i: { at: string }) => i.at, now)).toEqual([]);
  });
});
