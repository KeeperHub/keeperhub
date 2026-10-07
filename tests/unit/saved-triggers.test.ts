import { describe, expect, it } from "vitest";
import {
  dropSavedTriggersUpTo,
  recordSavedTrigger,
  type SavedTriggers,
} from "@/lib/workflow/saved-triggers";

const hourly = { triggerType: "Schedule", scheduleCron: "0 * * * *" };
const manual = { triggerType: "Manual" };

describe("recordSavedTrigger", () => {
  it("records a workflow's saved trigger with its sequence number", () => {
    expect(recordSavedTrigger({}, "w1", hourly, 1)).toEqual({
      w1: { config: hourly, seq: 1 },
    });
  });

  it("keeps the same object when the config has not changed", () => {
    const saved = recordSavedTrigger({}, "w1", hourly, 1);
    expect(recordSavedTrigger(saved, "w1", hourly, 2)).toBe(saved);
  });

  it("records a deleted trigger as no config", () => {
    const saved = recordSavedTrigger({}, "w1", hourly, 1);
    expect(recordSavedTrigger(saved, "w1", undefined, 2)).toEqual({
      w1: { config: undefined, seq: 2 },
    });
  });
});

describe("dropSavedTriggersUpTo", () => {
  const saved: SavedTriggers = {
    before: { config: hourly, seq: 1 },
    during: { config: manual, seq: 3 },
  };

  it("keeps what was saved after the fetch began, which its reply may lack", () => {
    expect(dropSavedTriggersUpTo(saved, 2)).toEqual({
      during: { config: manual, seq: 3 },
    });
  });

  it("drops everything a fetch that began later has", () => {
    expect(dropSavedTriggersUpTo(saved, 3)).toEqual({});
  });

  it("keeps the same object when nothing is dropped", () => {
    expect(dropSavedTriggersUpTo(saved, 0)).toBe(saved);
  });
});
