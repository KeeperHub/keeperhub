import { describe, expect, it } from "vitest";
import { matchBlocks } from "../../src/match/block-matcher";
import type { NormalizedBlock } from "../../src/match/types";
import type { SolanaBlockTrigger } from "../../src/registrations";

function block(blockHeight: number | null): NormalizedBlock {
  return {
    slot: 500,
    blockHeight,
    blockhash: "hash",
    blockTime: 1_700_000_000,
    parentSlot: 499,
    transactions: [],
  };
}

function trigger(
  blockInterval: number,
  workflowId = "wf-1",
): SolanaBlockTrigger {
  return {
    workflowId,
    userId: "user-1",
    workflowName: "wf",
    blockInterval,
    configHash: "hash",
  };
}

describe("matchBlocks", () => {
  it("fires when the interval divides the block height", () => {
    const fires = matchBlocks(block(10), [trigger(5)]);
    expect(fires).toHaveLength(1);
    expect(fires[0].workflowId).toBe("wf-1");
    expect(fires[0].payload.chainType).toBe("solana");
    expect(fires[0].payload.blockHeight).toBe(10);
  });

  it("does not fire when the interval does not divide the height", () => {
    expect(matchBlocks(block(10), [trigger(3)])).toEqual([]);
  });

  it("interval of 1 fires on every block", () => {
    expect(matchBlocks(block(7), [trigger(1)])).toHaveLength(1);
  });

  it("fires nothing when block height is null (older RPCs)", () => {
    expect(matchBlocks(block(null), [trigger(1)])).toEqual([]);
  });

  it("fires nothing when block height is zero", () => {
    expect(matchBlocks(block(0), [trigger(1)])).toEqual([]);
  });

  it("fires only the triggers whose interval matches", () => {
    const fires = matchBlocks(block(12), [
      trigger(6, "wf-6"),
      trigger(5, "wf-5"),
      trigger(4, "wf-4"),
    ]);
    expect(fires.map((f) => f.workflowId).sort()).toEqual(["wf-4", "wf-6"]);
  });
});
