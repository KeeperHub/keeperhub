import { describe, expect, it } from "vitest";
import { triggerBlockOf } from "@/lib/workflow/executor/trigger-block";

const BLOCK = { triggerType: "Block", network: "1", blockInterval: "1" };
const INPUT = { blockNumber: 101, blockTimestamp: 1_000_012 };

describe("triggerBlockOf", () => {
  it("reads a block-scheduler run's block and chain", () => {
    expect(triggerBlockOf(true, BLOCK, INPUT)).toEqual({
      chainId: 1,
      number: 101,
    });
    expect(
      triggerBlockOf(true, { ...BLOCK, network: "mainnet" }, INPUT)
    ).toEqual({ chainId: 1, number: 101 });
  });

  it.each([
    ["a run the block scheduler did not start", false, BLOCK, INPUT],
    ["an unknown source", undefined, BLOCK, INPUT],
    ["another trigger type", true, { ...BLOCK, triggerType: "Event" }, INPUT],
    ["no trigger", true, undefined, INPUT],
    ["no block in the input", true, BLOCK, {}],
    ["a string number", true, BLOCK, { blockNumber: "101" }],
    ["a fractional number", true, BLOCK, { blockNumber: 1.5 }],
    ["a zero number", true, BLOCK, { blockNumber: 0 }],
    ["an unknown network", true, { ...BLOCK, network: "nowhere" }, INPUT],
    ["no network", true, { ...BLOCK, network: undefined }, INPUT],
  ])("is undefined for %s", (_label, fromScheduler, config, input) => {
    expect(
      triggerBlockOf(
        fromScheduler,
        config as Record<string, unknown> | undefined,
        input as Record<string, unknown>
      )
    ).toBeUndefined();
  });
});
