import { describe, expect, it } from "vitest";
import {
  checkReadSimulationConfig,
  checkSimulationConfig,
} from "@/plugins/web3/simulation-config";

describe("checkSimulationConfig", () => {
  it("refuses at save the Simulate at values the step refuses at run time", () => {
    for (const value of ["next_block", "nextBlock", true]) {
      expect(checkSimulationConfig({ simulateAt: value })?.field).toBe(
        "simulateAt"
      );
    }
  });

  it("refuses an offset outside 1..60 only with Next block", () => {
    expect(
      checkSimulationConfig({
        simulateAt: "next-block",
        simulateTimestampOffsetSec: "61",
      })?.field
    ).toBe("simulateTimestampOffsetSec");
    expect(
      checkSimulationConfig({
        simulateAt: "latest",
        simulateTimestampOffsetSec: "99",
      })
    ).toBeUndefined();
  });

  it("leaves a template offset to the run", () => {
    expect(
      checkSimulationConfig({
        simulateAt: "next-block",
        simulateTimestampOffsetSec: "{{@a:Node.value}}",
      })
    ).toBeUndefined();
  });

  it("leaves a template Simulate at to the run", () => {
    expect(
      checkSimulationConfig({ simulateAt: "{{@a:Node.mode}}" })
    ).toBeUndefined();
  });
});

describe("checkReadSimulationConfig (Read Contract)", () => {
  it("accepts At a time with seconds, a zoned date or a template", () => {
    for (const simulateTime of [
      1_796_126_400,
      "2026-12-01T12:00:00Z",
      "{{@read:Next work time.result}}",
    ]) {
      expect(
        checkReadSimulationConfig({ simulateAt: "time", simulateTime })
      ).toBeUndefined();
    }
  });

  it.each([
    ["", "Enter a time, or set Simulate at to Latest block."],
    ["1796126400000", "This looks like milliseconds. Use seconds: 1796126400."],
    [
      "2026-12-01 12:00",
      "Add a time zone, such as Z for UTC: 2026-12-01T12:00:00Z.",
    ],
    [42, "Use a time from"],
  ])("refuses Time %j on its own field", (simulateTime, text) => {
    const issue = checkReadSimulationConfig({
      simulateAt: "time",
      simulateTime,
    });
    expect(issue?.field).toBe("simulateTime");
    expect(issue?.message).toContain(text);
  });

  it("keeps the write steps to Latest block and Next block", () => {
    expect(
      checkSimulationConfig({ simulateAt: "time", simulateTime: 1_796_126_400 })
        ?.field
    ).toBe("simulateAt");
    expect(
      checkReadSimulationConfig({ simulateAt: "next-block" })
    ).toBeUndefined();
  });
});
