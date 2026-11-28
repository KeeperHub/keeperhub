import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { minBlockGapSeconds } from "@/lib/web3/beacon-slots";
import {
  firstAllowedBlock,
  maxFeeForTips,
  planSendAhead,
  planTips,
  toGwei,
} from "@/lib/web3/bundles/plan";
import { readBundleSettings } from "@/lib/web3/bundles/settings";
import { readUnixTime } from "@/lib/web3/unix-time";

const gwei = (value: string): bigint => ethers.parseUnits(value, "gwei");
const SLOT = 12;

describe("firstAllowedBlock", () => {
  const base = { number: 1000, timestamp: 1_800_000_000 };

  it("is the first block whose earliest time reaches Not before", () => {
    // 36 s ahead: block 1003 is at least 36 s after base.
    expect(firstAllowedBlock(base.timestamp + 36, base, SLOT)).toBe(1003);
    // One second more needs one block more.
    expect(firstAllowedBlock(base.timestamp + 37, base, SLOT)).toBe(1004);
    expect(firstAllowedBlock(base.timestamp + 35, base, SLOT)).toBe(1003);
  });

  it("is never before base + 1, also for a time already passed", () => {
    expect(firstAllowedBlock(base.timestamp, base, SLOT)).toBe(1001);
    expect(firstAllowedBlock(base.timestamp - 500, base, SLOT)).toBe(1001);
    expect(firstAllowedBlock(0, base, SLOT)).toBe(1001);
  });

  it("can never be early, whatever slots are missed after base", () => {
    // Every chain of block times from base, each gap a slot or more (missed slots).
    for (
      let notBefore = base.timestamp - 20;
      notBefore < base.timestamp + 80;
      notBefore++
    ) {
      const allowed = firstAllowedBlock(notBefore, base, SLOT);
      for (const missed of [0, 1, 2, 5]) {
        // The earliest time block `allowed` can have, with `missed` slots skipped.
        const earliest =
          base.timestamp + SLOT * (allowed - base.number) + SLOT * missed;
        expect(earliest).toBeGreaterThanOrEqual(notBefore);
      }
      // And it is the first such block with no slot missed.
      const before = allowed - 1;
      if (before > base.number) {
        expect(base.timestamp + SLOT * (before - base.number)).toBeLessThan(
          notBefore
        );
      }
    }
  });

  it("knows 12 s on Ethereum and 5 s on Gnosis, and no gap on chains without fixed slots", () => {
    expect(minBlockGapSeconds(1)).toBe(12);
    expect(minBlockGapSeconds(11_155_111)).toBe(12);
    expect(minBlockGapSeconds(100)).toBe(5);
    // Arbitrum, BSC and a local chain can repeat timestamps: no safe gap.
    expect(minBlockGapSeconds(42_161)).toBeUndefined();
    expect(minBlockGapSeconds(56)).toBeUndefined();
    expect(minBlockGapSeconds(31_337)).toBeUndefined();
  });
});

describe("planSendAhead", () => {
  const plan = (options: {
    notBefore: number;
    latest?: number;
    parentTime?: number;
    sendAhead?: number;
    blocks?: number;
  }) => {
    const latest = options.latest ?? 1000;
    return planSendAhead({
      notBefore: options.notBefore,
      latest,
      // The parent is a slot before latest unless a test says otherwise.
      parent: {
        number: latest - 1,
        timestamp: options.parentTime ?? 1_800_000_000,
      },
      gapSeconds: SLOT,
      sendAheadBlocks: options.sendAhead ?? 2,
      blocks: options.blocks ?? 3,
    });
  };
  const T = 1_800_000_000;

  it("waits while U is more than Send ahead + 1 blocks away", () => {
    // From parent 999: U = 999 + 5 = 1004 > 1000 + 1 + 2.
    expect(plan({ notBefore: T + 60 })).toEqual({
      kind: "waiting",
      firstAllowedBlock: 1004,
    });
  });

  it("sends from U when it is exactly Send ahead + 1 blocks away", () => {
    // U = 999 + 4 = 1003 = latest + 1 + 2.
    expect(plan({ notBefore: T + 48 })).toEqual({
      kind: "send",
      firstAllowedBlock: 1003,
      targets: [1003, 1004, 1005],
    });
  });

  it("with Send ahead 0 sends only when U is the next block", () => {
    expect(plan({ notBefore: T + 24, sendAhead: 0 })).toMatchObject({
      kind: "send",
      targets: [1001, 1002, 1003],
    });
    expect(plan({ notBefore: T + 36, sendAhead: 0 })).toMatchObject({
      kind: "waiting",
      firstAllowedBlock: 1002,
    });
  });

  it("starts at the next block when U has passed (a late run)", () => {
    expect(plan({ notBefore: T - 100 })).toEqual({
      kind: "send",
      firstAllowedBlock: 1000,
      targets: [1001, 1002, 1003],
    });
  });

  it("never targets past latest + 5 with Send ahead + Target blocks at 5", () => {
    for (let notBefore = T - 50; notBefore < T + 200; notBefore++) {
      for (const [sendAhead, blocks] of [
        [0, 5],
        [2, 3],
        [3, 2],
      ]) {
        const result = plan({ notBefore, sendAhead, blocks });
        if (result.kind === "send") {
          expect(Math.max(...result.targets)).toBeLessThanOrEqual(1005);
          expect(result.targets[0]).toBeGreaterThanOrEqual(
            result.firstAllowedBlock
          );
        }
      }
    }
  });

  it("is safe against a reorg of the head: counted from the parent, not latest", () => {
    // Latest 1000 claims time T + 24, but its parent 999 is at T: a missed slot, or a head
    // that a reorg may replace with a block at T + 12. U from the parent stays safe for both.
    const result = plan({ notBefore: T + 36 });
    expect(result.firstAllowedBlock).toBe(1002);
    // A replacement head at T + 12 makes block 1002 at least T + 36: never early.
    expect(T + 12 + SLOT * (1002 - 1000)).toBeGreaterThanOrEqual(T + 36);
    // Counting from the claimed head (T + 24) would give 1001, which could be at T + 24.
    expect(
      firstAllowedBlock(T + 36, { number: 1000, timestamp: T + 24 }, SLOT)
    ).toBe(1001);
  });

  it("recomputed from a newer latest after a missed slot, U moves earlier and is still never early", () => {
    const first = plan({ notBefore: T + 120, latest: 1000, parentTime: T });
    // Two blocks later, one slot missed between them.
    const later = plan({
      notBefore: T + 120,
      latest: 1002,
      parentTime: T + 36,
    });
    expect(later.firstAllowedBlock).toBeLessThanOrEqual(
      first.firstAllowedBlock
    );
    // Still never early: block U from parent 1001 at T + 36.
    expect(
      T + 36 + SLOT * (later.firstAllowedBlock - 1001)
    ).toBeGreaterThanOrEqual(T + 120);
  });
});

describe("tips counted from the first target", () => {
  it("gives the first allowed block the plain tip: 1x, 1.2x, 1.44x from U", () => {
    const plan = planTips({
      latest: 100,
      parent: null,
      firstTip: gwei("1"),
      maxFee: gwei("1000"),
      increasePercent: 20,
      blocks: [103, 104, 105],
      firstTarget: 103,
    });
    expect(plan.targets.map((t) => toGwei(t.tip))).toEqual([
      "1",
      "1.2",
      "1.44",
    ]);
  });

  it("keeps a skipped first target's place in the tip ladder", () => {
    const plan = planTips({
      latest: 100,
      parent: null,
      firstTip: gwei("1"),
      maxFee: gwei("1000"),
      increasePercent: 20,
      blocks: [104, 105],
      firstTarget: 103,
    });
    expect(plan.targets.map((t) => toGwei(t.tip))).toEqual(["1.2", "1.44"]);
  });

  it("still projects the base fee from latest, so a far target can be skipped for fee", () => {
    const parent = {
      baseFee: gwei("10"),
      gasUsed: BigInt(30_000_000),
      gasLimit: BigInt(30_000_000),
    };
    const plan = planTips({
      latest: 100,
      parent,
      firstTip: gwei("1"),
      // Next block 11.25; three blocks on, up to about 16.02.
      maxFee: gwei("15"),
      increasePercent: 0,
      blocks: [103, 104, 105],
      firstTarget: 103,
    });
    expect(plan.targets.map((t) => t.block)).toEqual([103]);
    expect(plan.skipped.map((s) => s.block)).toEqual([104, 105]);
  });

  it("raises the fee cap by the tip from the first target and the base fee from latest", () => {
    const parent = {
      baseFee: gwei("10"),
      gasUsed: BigInt(15_000_000),
      gasLimit: BigInt(30_000_000),
    };
    const fromU = maxFeeForTips({
      estimatedMaxFee: gwei("11"),
      firstTip: gwei("1"),
      increasePercent: 100,
      latest: 100,
      blocks: [103, 104, 105],
      parent,
      firstTarget: 103,
    });
    // Last tip 4x (third from U, not fifth from latest: 16x); base fee 10 grows four blocks.
    const projected =
      (gwei("10") * BigInt(9 ** 4) + BigInt(8 ** 4) - BigInt(1)) /
      BigInt(8 ** 4);
    expect(fromU).toBe(projected + gwei("4"));
    const fromLatest = maxFeeForTips({
      estimatedMaxFee: gwei("11"),
      firstTip: gwei("1"),
      increasePercent: 100,
      latest: 100,
      blocks: [103, 104, 105],
      parent,
    });
    expect(fromLatest).toBe(projected + gwei("16"));
  });
});

describe("readUnixTime", () => {
  it.each([
    [1_796_126_400, 1_796_126_400],
    ["1796126400", 1_796_126_400],
    [" 01796126400 ", 1_796_126_400],
    [BigInt(1_796_126_400), 1_796_126_400],
    ["2026-12-01T12:00:00Z", 1_796_126_400],
    ["2026-12-01t12:00:00z", 1_796_126_400],
    ["2026-12-01 12:00:00Z", 1_796_126_400],
    ["2026-12-01T12:00Z", 1_796_126_400],
    ["2026-12-01T13:00:00+01:00", 1_796_126_400],
    ["2026-12-01T07:00:00-0500", 1_796_126_400],
    // A fraction rounds up: never early.
    ["2026-12-01T11:59:59.001Z", 1_796_126_400],
    ["2024-02-29T00:00:00Z", 1_709_164_800],
  ])("reads %s", (value, seconds) => {
    expect(readUnixTime(value, { strict: true })).toEqual({
      ok: true,
      seconds,
    });
  });

  it.each([
    ["1796126400000000", "microseconds", "1796126400"],
    ["1796126400000000001", "nanoseconds", "1796126401"],
  ])("refuses %s as %s, rounded up", (value, unit, seconds) => {
    for (const strict of [true, false]) {
      expect(readUnixTime(value, { strict })).toEqual({
        ok: false,
        reason: `This looks like ${unit}. Use seconds: ${seconds}.`,
      });
    }
  });

  it.each([
    "2026-12-01T12:00:00+14:01",
    "2026-12-01T12:00:00-15:00",
    "2026-12-01T12:00:00+05:60",
    "2026-12-01T12:00:00+0099",
  ])("refuses a zone offset that is not real: %s", (value) => {
    expect(readUnixTime(value, { strict: true })).toEqual({
      ok: false,
      reason:
        "This time zone offset is not real. Use one from -14:00 to +14:00.",
    });
  });

  it("takes offsets up to 14 hours", () => {
    expect(readUnixTime("2026-12-02T02:00:00+14:00", { strict: true })).toEqual(
      { ok: true, seconds: 1_796_126_400 }
    );
    expect(readUnixTime("2026-11-30T22:00:00-14:00", { strict: true })).toEqual(
      { ok: true, seconds: 1_796_126_400 }
    );
  });

  it("refuses milliseconds with the seconds to use, rounded up", () => {
    expect(readUnixTime("1796126400000", { strict: true })).toEqual({
      ok: false,
      reason: "This looks like milliseconds. Use seconds: 1796126400.",
    });
    expect(readUnixTime(1_796_126_400_001, { strict: false })).toEqual({
      ok: false,
      reason: "This looks like milliseconds. Use seconds: 1796126401.",
    });
  });

  it("asks for a zone, with the UTC form", () => {
    expect(readUnixTime("2026-12-01 12:00", { strict: true })).toEqual({
      ok: false,
      reason: "Add a time zone, such as Z for UTC: 2026-12-01T12:00:00Z.",
    });
    expect(readUnixTime("2026-12-01", { strict: true })).toMatchObject({
      reason: "Add a time zone, such as Z for UTC: 2026-12-01T00:00:00Z.",
    });
  });

  it.each([
    "2026-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-12-01T24:00:00Z",
  ])("refuses a date that does not exist: %s", (value) => {
    expect(readUnixTime(value, { strict: true })).toEqual({
      ok: false,
      reason: "This is not a real date and time.",
    });
  });

  it.each([-1, 1.5, "1.5", "-5", "soon", true, null, {}, Number.NaN])(
    "refuses %j",
    (value) => {
      expect(readUnixTime(value, { strict: false }).ok).toBe(false);
    }
  );

  it("keeps a saved literal to 2001..2286, and returns a resolved value as read for the caller to check", () => {
    expect(readUnixTime(999_999_999, { strict: true }).ok).toBe(false);
    expect(readUnixTime(10_000_000_000, { strict: true }).ok).toBe(false);
    expect(readUnixTime(1_000_000_000, { strict: true }).ok).toBe(true);
    expect(readUnixTime(9_999_999_999, { strict: true }).ok).toBe(true);
    expect(readUnixTime(0, { strict: false })).toEqual({
      ok: true,
      seconds: 0,
    });
    expect(readUnixTime(99_999_999_999, { strict: false })).toEqual({
      ok: true,
      seconds: 99_999_999_999,
    });
    const huge = readUnixTime(ethers.MaxUint256.toString(), { strict: false });
    expect(huge.ok && huge.seconds > 9_999_999_999).toBe(true);
  });
});

describe("readBundleSettings: Not before and Send ahead", () => {
  it("has no send-ahead without Not before, as in step 4", () => {
    expect(readBundleSettings({ sendAheadBlocks: 3, bundleBlocks: 5 })).toEqual(
      {
        ok: true,
        settings: { blocks: 5, tipIncreasePercent: 0 },
      }
    );
  });

  it("reads Not before with Send ahead 2 by default", () => {
    expect(readBundleSettings({ notBefore: "2026-12-01T12:00:00Z" })).toEqual({
      ok: true,
      settings: {
        blocks: 3,
        tipIncreasePercent: 0,
        sendAhead: { notBefore: 1_796_126_400, blocks: 2 },
      },
    });
    expect(
      readBundleSettings({ notBefore: 1_796_126_400, sendAheadBlocks: "0" })
        .ok &&
        readBundleSettings({ notBefore: 1_796_126_400, sendAheadBlocks: "0" })
    ).toMatchObject({ settings: { sendAhead: { blocks: 0 } } });
  });

  it("refuses Send ahead + Target blocks above 5, naming both", () => {
    expect(
      readBundleSettings({ notBefore: 1_796_126_400, bundleBlocks: 4 })
    ).toEqual({
      ok: false,
      field: "sendAheadBlocks",
      error:
        "Send ahead (2) + Target blocks (4) is 6. Together they can be at most 5, so lower one of them (sendAheadBlocks, bundleBlocks).",
    });
    expect(
      readBundleSettings({
        notBefore: 1_796_126_400,
        bundleBlocks: 5,
        sendAheadBlocks: 0,
      }).ok
    ).toBe(true);
  });

  it.each([4, -1, 1.5, "{{@n:N.x}}", "two"])(
    "refuses sendAheadBlocks %j",
    (sendAheadBlocks) => {
      const read = readBundleSettings({ sendAheadBlocks });
      expect(read).toMatchObject({ ok: false, field: "sendAheadBlocks" });
    }
  );

  it("lets a template through at save and reads its value at run time", () => {
    const templated = { notBefore: "{{@read:Read Contract.result}}" };
    expect(readBundleSettings(templated, "save")).toEqual({
      ok: true,
      settings: { blocks: 3, tipIncreasePercent: 0 },
    });
    // At run time a template still unfilled is a refusal the step fails with after its in-flight check.
    expect(readBundleSettings(templated, "run")).toEqual({
      ok: true,
      settings: {
        blocks: 3,
        tipIncreasePercent: 0,
        notBeforeRefusal:
          'Not before (notBefore) still holds a template after it was filled in, so nothing was sent: "{{@read:Read Contract.result}}".',
      },
    });
    // The resolved value (a uint256 as text) is read as unix seconds.
    expect(
      readBundleSettings({ notBefore: "1796126400" }, "run")
    ).toMatchObject({
      ok: true,
      settings: { sendAhead: { notBefore: 1_796_126_400 } },
    });
    // The sum rule holds for a template too, and stays an error at run time.
    expect(
      readBundleSettings({ ...templated, bundleBlocks: 5 }, "save").ok
    ).toBe(false);
    expect(
      readBundleSettings({ notBefore: "0", bundleBlocks: 5 }, "run")
    ).toMatchObject({ ok: false, field: "sendAheadBlocks" });
  });

  // The run-time refusal text, or undefined when the run sends.
  const runRefusal = (input: Record<string, unknown>) => {
    const read = readBundleSettings(input, "run");
    return read.ok ? read.settings.notBeforeRefusal : `error: ${read.error}`;
  };

  it("refuses milliseconds at save and at run time, with the canvas words", () => {
    const save = readBundleSettings({ notBefore: "1796126400000" }, "save");
    expect(save).toMatchObject({ ok: false, field: "notBefore" });
    expect(!save.ok && save.error).toContain(
      "This looks like milliseconds. Use seconds: 1796126400."
    );
    expect(runRefusal({ notBefore: "1796126400000" })).toBe(
      'Not before (notBefore) "1796126400000": This looks like milliseconds. Use seconds: 1796126400. Nothing was sent.'
    );
  });

  it("fails a templated Not before that resolved empty, instead of turning the gate off", () => {
    for (const notBefore of ["", null, undefined]) {
      const read = readBundleSettings(
        { notBefore, _notBeforeFromTemplate: true },
        "run"
      );
      expect(read).toEqual({
        ok: true,
        settings: {
          blocks: 3,
          tipIncreasePercent: 0,
          notBeforeRefusal:
            "Not before (notBefore) resolved to an empty value, so nothing was sent.",
        },
      });
      // A field left empty in the editor (no template) still means off.
      expect(readBundleSettings({ notBefore }, "run")).toEqual({
        ok: true,
        settings: { blocks: 3, tipIncreasePercent: 0 },
      });
    }
    // Save never sees a resolved value.
    expect(
      readBundleSettings(
        { notBefore: "", _notBeforeFromTemplate: true },
        "save"
      ).ok
    ).toBe(true);
  });

  const ZERO =
    "Not before (notBefore) resolved to 0, which usually means the time is not set yet, so nothing was sent.";
  const small = (value: number) =>
    `Not before (notBefore) resolved to ${value}, which looks like a duration or block number, not a unix time, so nothing was sent.`;
  const large = (value: number) =>
    `Not before (notBefore) resolved to ${value}, which is past the year 2286 and is not a unix time (an amount, or a 'never' value such as the largest uint256), so nothing was sent.`;
  const outside = (value: string) =>
    `Not before (notBefore) resolved to ${value}, which is before 2001-09-09 or after 2286-11-20, so nothing was sent.`;

  it.each([
    ["0", ZERO],
    [0, ZERO],
    [3600, small(3600)],
    ["19000000", small(19_000_000)],
    [999_999_999, small(999_999_999)],
    ["10000000000", large(10_000_000_000)],
    [99_999_999_999, large(99_999_999_999)],
  ])(
    "fails a run-time Not before of %j, templated or literal",
    (notBefore, error) => {
      expect(runRefusal({ notBefore, _notBeforeFromTemplate: true })).toBe(
        error
      );
      expect(runRefusal({ notBefore })).toBe(error);
    }
  );

  it.each([
    "2000-12-31T23:59:59Z",
    "1970-01-01T00:00:00Z",
    "0050-06-01T00:00:00Z",
    "2287-01-01T00:00:00Z",
  ])(
    "names only the range for a run-time date of %s outside it",
    (notBefore) => {
      expect(runRefusal({ notBefore, _notBeforeFromTemplate: true })).toBe(
        outside(notBefore)
      );
    }
  );

  it("sends at both run-time boundaries, templated or literal", () => {
    for (const notBefore of ["1000000000", 9_999_999_999]) {
      for (const mark of [{ _notBeforeFromTemplate: true }, {}]) {
        expect(readBundleSettings({ notBefore, ...mark }, "run")).toMatchObject(
          {
            ok: true,
            settings: { sendAhead: { notBefore: Number(notBefore) } },
          }
        );
      }
    }
  });

  it("keeps the subsecond hint for 13, 16 and 19 digits at run time", () => {
    expect(runRefusal({ notBefore: "1796126400000000" })).toContain(
      "This looks like microseconds. Use seconds: 1796126400."
    );
    expect(
      runRefusal({
        notBefore: "1796126400000000001",
        _notBeforeFromTemplate: true,
      })
    ).toContain("This looks like nanoseconds. Use seconds: 1796126401.");
  });

  it("refuses a literal 0 at save", () => {
    for (const notBefore of [0, "0"]) {
      expect(readBundleSettings({ notBefore }, "save")).toMatchObject({
        ok: false,
        field: "notBefore",
      });
    }
  });

  it("refuses a literal out of range at save, and fails it at run time", () => {
    expect(readBundleSettings({ notBefore: 12_345 }, "save").ok).toBe(false);
    expect(runRefusal({ notBefore: 12_345 })).toBe(small(12_345));
  });
});
