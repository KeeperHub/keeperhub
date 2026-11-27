import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { planTips, toGwei } from "@/lib/web3/bundles/plan";

const gwei = (value: string): bigint => ethers.parseUnits(value, "gwei");
const HIGH_MAX_FEE = gwei("1000");

// The k-th target's tip through planTips; no base fee, so no target is skipped.
function tipForTarget(
  firstTip: bigint,
  maxFee: bigint,
  increasePercent: number,
  k: number
): bigint {
  const plan = planTips({
    latest: 100,
    parent: null,
    firstTip,
    maxFee,
    increasePercent,
    blocks: [100 + k],
  });
  return plan.targets[0].tip;
}

describe("tips per target", () => {
  it("raises 20% per block: 1x, 1.2x, 1.44x over 3 targets", () => {
    const tips = [1, 2, 3].map((k) =>
      tipForTarget(gwei("1"), HIGH_MAX_FEE, 20, k)
    );
    expect(tips.map(toGwei)).toEqual(["1", "1.2", "1.44"]);
  });

  it.each([
    [0, ["2", "2", "2", "2", "2"]],
    [20, ["2", "2.4", "2.88", "3.456", "4.1472"]],
    [100, ["2", "4", "8", "16", "32"]],
  ])("compounds %i%% over 5 targets exactly", (percent, expected) => {
    const tips = [1, 2, 3, 4, 5].map((k) =>
      tipForTarget(gwei("2"), HIGH_MAX_FEE, percent, k)
    );
    expect(tips.map(toGwei)).toEqual(expected);
  });

  it("rounds a fraction of a wei up, never down", () => {
    expect(tipForTarget(BigInt(7), HIGH_MAX_FEE, 20, 2)).toBe(BigInt(9));
    expect(tipForTarget(BigInt(5), HIGH_MAX_FEE, 20, 3)).toBe(BigInt(8));
  });

  it("never goes above Max Fee", () => {
    expect(tipForTarget(gwei("1"), gwei("1.5"), 100, 3)).toBe(gwei("1.5"));
    expect(tipForTarget(gwei("2"), gwei("1"), 0, 1)).toBe(gwei("1"));
  });
});

describe("projected base fee", () => {
  // Half full: the next base fee is 800 wei, then at most 900, 1013.
  const plan = (maxFee: number, k: number) =>
    planTips({
      latest: 100,
      parent: {
        baseFee: BigInt(800),
        gasUsed: BigInt(15_000_000),
        gasLimit: BigInt(30_000_000),
      },
      firstTip: BigInt(1),
      maxFee: BigInt(maxFee),
      increasePercent: 0,
      blocks: [100 + k],
    });

  it("grows at most 12.5% per block, rounded up", () => {
    expect(plan(900, 2).targets).toHaveLength(1);
    expect(plan(899, 2).skipped).toHaveLength(1);
    expect(plan(899, 2).lowestSkippedBaseFee).toBe(BigInt(900));
    expect(plan(1013, 3).targets).toHaveLength(1);
    expect(plan(1012, 3).lowestSkippedBaseFee).toBe(BigInt(1013));
  });
});

describe("next block's base fee (EIP-1559)", () => {
  // The first target's projected base fee, read from a refusal at a 1 wei Max Fee.
  const nextBaseFee = (parent: {
    baseFee: bigint;
    gasUsed: bigint;
    gasLimit: bigint;
  }): bigint | undefined =>
    planTips({
      latest: 100,
      parent,
      firstTip: BigInt(1),
      maxFee: BigInt(1),
      increasePercent: 0,
      blocks: [101],
    }).lowestSkippedBaseFee;
  const parent = (used: number) => ({
    baseFee: gwei("8"),
    gasUsed: BigInt(used),
    gasLimit: BigInt(30_000_000),
  });

  it("falls 12.5% after an empty block, stays at half full, rises 12.5% when full", () => {
    expect(nextBaseFee(parent(0))).toBe(gwei("7"));
    expect(nextBaseFee(parent(15_000_000))).toBe(gwei("8"));
    expect(nextBaseFee(parent(30_000_000))).toBe(gwei("9"));
  });

  it("rises by at least 1 wei above target", () => {
    expect(
      nextBaseFee({
        baseFee: BigInt(7),
        gasUsed: BigInt(15_000_001),
        gasLimit: BigInt(30_000_000),
      })
    ).toBe(BigInt(8));
  });
});

describe("planTips", () => {
  // Half full: the next base fee equals this one.
  const halfFull = {
    baseFee: gwei("10"),
    gasUsed: BigInt(15_000_000),
    gasLimit: BigInt(30_000_000),
  };
  const base = {
    latest: 100,
    parent: halfFull,
    firstTip: gwei("1"),
    maxFee: gwei("30"),
    increasePercent: 20,
  };

  it("tips each target by its distance from latest, even past a skipped one", () => {
    const plan = planTips({ ...base, blocks: [101, 103] });
    expect(plan.skipped).toEqual([]);
    expect(plan.targets.map((t) => [t.block, toGwei(t.tip)])).toEqual([
      [101, "1"],
      [103, "1.44"],
    ]);
  });

  it("skips a target whose projected base fee can pass Max Fee", () => {
    // Target 1 is exactly 10 gwei; then up to 11.25, 12.66: 11.5 gwei covers two.
    const plan = planTips({
      ...base,
      maxFee: gwei("11.5"),
      blocks: [101, 102, 103],
    });
    expect(plan.targets.map((t) => t.block)).toEqual([101, 102]);
    expect(plan.skipped).toEqual([
      { block: 103, reason: "max-fee-below-projected-base-fee" },
    ]);
  });

  it("keeps target 1 when its exact base fee fits, though 12.5% more would not", () => {
    const plan = planTips({
      ...base,
      parent: { ...halfFull, gasUsed: BigInt(0) },
      maxFee: gwei("9"),
      blocks: [101],
    });
    expect(plan.targets.map((t) => t.block)).toEqual([101]);
  });

  it("skips no target when the block has no base fee", () => {
    const plan = planTips({ ...base, parent: null, blocks: [101, 102] });
    expect(plan.targets).toHaveLength(2);
  });
});

describe("toGwei", () => {
  it("drops a trailing .0 and keeps wei precision", () => {
    expect(toGwei(gwei("3"))).toBe("3");
    expect(toGwei(BigInt(1))).toBe("0.000000001");
  });
});
