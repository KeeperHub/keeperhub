import { describe, expect, it } from "vitest";
import { triggerBlockOf } from "@/lib/workflow/executor/trigger-block";

const PARENT = `0x${"ab".repeat(32)}`;
const BLOCK = { triggerType: "Block", network: "1", blockInterval: "1" };
const INPUT = {
  blockNumber: 101,
  blockTimestamp: 1_000_012,
  parentHash: PARENT,
};

describe("triggerBlockOf", () => {
  it("reads a block-scheduler run's block and chain", () => {
    const expected = {
      chainId: 1,
      number: 101,
      timestamp: 1_000_012,
      parentHash: PARENT,
    };
    expect(triggerBlockOf(true, BLOCK, INPUT)).toEqual(expected);
    expect(
      triggerBlockOf(true, { ...BLOCK, network: "mainnet" }, INPUT)
    ).toEqual(expected);
  });

  it.each([
    ["a run the block scheduler did not start", false, BLOCK, INPUT],
    ["an unknown source", undefined, BLOCK, INPUT],
    ["another trigger type", true, { ...BLOCK, triggerType: "Event" }, INPUT],
    ["no trigger", true, undefined, INPUT],
    ["no block in the input", true, BLOCK, {}],
    ["a string number", true, BLOCK, { ...INPUT, blockNumber: "101" }],
    ["a fractional number", true, BLOCK, { ...INPUT, blockNumber: 1.5 }],
    ["a negative timestamp", true, BLOCK, { ...INPUT, blockTimestamp: -1 }],
    ["no parent hash", true, BLOCK, { ...INPUT, parentHash: undefined }],
    ["a short parent hash", true, BLOCK, { ...INPUT, parentHash: "0xab" }],
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
