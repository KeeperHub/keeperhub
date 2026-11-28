import { describe, expect, it } from "vitest";
import { readBundleSettings } from "@/lib/web3/bundles/settings";

describe("readBundleSettings", () => {
  it("defaults to 3 blocks, no tip increase and every builder", () => {
    expect(readBundleSettings({})).toEqual({
      ok: true,
      settings: { blocks: 3, tipIncreasePercent: 0, fallback: "stop" },
    });
    expect(
      readBundleSettings({
        bundleBlocks: "",
        bundleTipIncreasePercent: null,
        bundleBuilders: [],
      })
    ).toEqual({
      ok: true,
      settings: { blocks: 3, tipIncreasePercent: 0, fallback: "stop" },
    });
  });

  it("reads numbers and their decimal text", () => {
    expect(
      readBundleSettings({
        bundleBlocks: "5",
        bundleTipIncreasePercent: 20,
        bundleBuilders: ["flashbots", "titan", "flashbots"],
      })
    ).toEqual({
      ok: true,
      settings: {
        blocks: 5,
        tipIncreasePercent: 20,
        fallback: "stop",
        builders: ["flashbots", "titan"],
      },
    });
  });

  it("reads a builder list sent as JSON text", () => {
    const read = readBundleSettings({ bundleBuilders: '["titan"]' });
    expect(read.ok && read.settings.builders).toEqual(["titan"]);
  });

  it.each([0, 6, 2.5, "3.0", "-1", "{{@n:N.blocks}}", true])(
    "refuses bundleBlocks %j",
    (bundleBlocks) => {
      const read = readBundleSettings({ bundleBlocks });
      expect(read).toEqual({
        ok: false,
        field: "bundleBlocks",
        error: expect.stringContaining(
          "Target blocks (bundleBlocks) must be a whole number from 1 to 5"
        ),
      });
    }
  );

  it.each([-1, 101, 1.5, "abc"])(
    "refuses bundleTipIncreasePercent %j",
    (bundleTipIncreasePercent) => {
      const read = readBundleSettings({ bundleTipIncreasePercent });
      expect(read.ok).toBe(false);
    }
  );

  it.each([
    "not json",
    '{"a":1}',
    [""],
    [1],
    Array.from({ length: 17 }, (_, i) => `b${i}`),
  ])("refuses bundleBuilders %j", (bundleBuilders) => {
    expect(readBundleSettings({ bundleBuilders }).ok).toBe(false);
  });

  it("reads If not included: empty is stop, then stop or public only, never a template", () => {
    for (const unset of [undefined, null, ""]) {
      expect(readBundleSettings({ bundleFallback: unset })).toMatchObject({
        ok: true,
        settings: { fallback: "stop" },
      });
    }
    for (const value of ["stop", "public"]) {
      expect(
        readBundleSettings({ bundleFallback: value }, "save")
      ).toMatchObject({ ok: true, settings: { fallback: value } });
    }
    for (const value of ["Public", "{{@a:A.mode}}", true, 1, " public"]) {
      expect(readBundleSettings({ bundleFallback: value }, "save")).toEqual({
        ok: false,
        field: "bundleFallback",
        error: `If not included (bundleFallback) must be "stop" or "public", with no templates, not ${JSON.stringify(value)}.`,
      });
    }
  });
});
