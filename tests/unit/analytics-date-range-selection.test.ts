import { describe, expect, it } from "vitest";
import {
  endOfDay,
  nextRangeStep,
  startOfDay,
} from "@/lib/analytics/date-range-selection";

const AUG_10 = new Date(2026, 7, 10, 13, 30);
const AUG_20 = new Date(2026, 7, 20, 9, 15);

describe("nextRangeStep", () => {
  it("starts a range on the first click", () => {
    expect(nextRangeStep(undefined, AUG_10)).toEqual({
      kind: "start",
      from: AUG_10,
    });
  });

  it("closes the range on the second click", () => {
    const step = nextRangeStep({ from: AUG_10 }, AUG_20);
    expect(step.kind).toBe("complete");
    if (step.kind === "complete") {
      expect(step.from).toEqual(startOfDay(AUG_10));
      expect(step.to).toEqual(endOfDay(AUG_20));
    }
  });

  // The regression: handed a range that is already closed, every further click
  // used to report a completed range, so the picker applied and dismissed on
  // each one instead of starting over.
  it("starts a new range rather than extending a closed one", () => {
    expect(
      nextRangeStep({ from: AUG_10, to: AUG_20 }, new Date(2026, 8, 1)).kind
    ).toBe("start");
  });

  it("swaps the ends when the second click lands earlier", () => {
    const step = nextRangeStep({ from: AUG_20 }, AUG_10);
    expect(step.kind).toBe("complete");
    if (step.kind === "complete") {
      expect(step.from).toEqual(startOfDay(AUG_10));
      expect(step.to).toEqual(endOfDay(AUG_20));
    }
  });

  it("reads two clicks on one date as that single day", () => {
    const step = nextRangeStep({ from: AUG_10 }, AUG_10);
    expect(step.kind).toBe("complete");
    if (step.kind === "complete") {
      expect(step.from).toEqual(startOfDay(AUG_10));
      expect(step.to).toEqual(endOfDay(AUG_10));
    }
  });

  it("covers the whole day at both ends", () => {
    expect(startOfDay(AUG_10).getHours()).toBe(0);
    expect(endOfDay(AUG_10).getHours()).toBe(23);
    expect(endOfDay(AUG_10).getMilliseconds()).toBe(999);
  });
});
