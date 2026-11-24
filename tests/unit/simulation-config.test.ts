import { describe, expect, it } from "vitest";
import { checkSimulationConfig } from "@/plugins/web3/simulation-config";

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
