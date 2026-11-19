import { describe, expect, it } from "vitest";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { MAX_FILTER_ITEMS } from "@/plugins/data/filter-config";
import {
  checkCompareArraysConfig,
  compareArrays,
} from "@/plugins/data/steps/compare-arrays-core";
import { findActionById } from "@/plugins/registry";

type Success = Extract<ReturnType<typeof compareArrays>, { success: true }>;

function ok(input: Parameters<typeof compareArrays>[0]): Success {
  const result = compareArrays(input);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result;
}

function fail(input: Parameters<typeof compareArrays>[0]): string {
  const result = compareArrays(input);
  if (result.success) {
    throw new Error("expected failure");
  }
  expect(result.errorClass).toBe(ExecutionErrorType.USER);
  return result.error;
}

describe("compareArrays by value", () => {
  it("reports added, removed and unchanged primitives", () => {
    const result = ok({ previous: ["a", "b", "c"], current: ["b", "c", "d"] });
    expect(result.added).toEqual(["d"]);
    expect(result.removed).toEqual(["a"]);
    expect(result.unchanged).toEqual(["b", "c"]);
    expect(result.changed).toEqual([]);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.changedCount).toBe(0);
    expect(result.hasChanges).toBe(true);
  });

  it('keeps 1 and "1" apart', () => {
    const result = ok({ previous: [1], current: ["1"] });
    expect(result.added).toEqual(["1"]);
    expect(result.removed).toEqual([1]);
  });

  it("reports no changes for identical arrays", () => {
    const result = ok({ previous: [1, 2], current: [2, 1] });
    expect(result.hasChanges).toBe(false);
    expect(result.unchanged).toEqual([2, 1]);
  });

  it("matches objects by deep value regardless of key order", () => {
    const result = ok({
      previous: [{ a: 1, b: { c: 2, d: 3 } }],
      current: [{ b: { d: 3, c: 2 }, a: 1 }],
    });
    expect(result.hasChanges).toBe(false);
    expect(result.unchanged).toHaveLength(1);
  });

  it("accepts JSON text for both arrays", () => {
    const result = ok({ previous: '["a"]', current: '["a","b"]' });
    expect(result.added).toEqual(["b"]);
  });

  it("merged is previous plus added, removed items kept", () => {
    const result = ok({ previous: ["a", "b"], current: ["b", "c"] });
    expect(result.merged).toEqual(["a", "b", "c"]);
  });

  it("ignores repeats within a side; first occurrence wins", () => {
    const result = ok({ previous: ["a", "a"], current: ["a", "b", "b"] });
    expect(result.added).toEqual(["b"]);
    expect(result.unchanged).toEqual(["a"]);
    expect(result.merged).toEqual(["a", "b"]);
  });
});

describe("compareArrays first run", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["blank string", "  "],
    ["null text", "null"],
  ])("treats previous %s as empty", (_name, previous) => {
    const result = ok({ previous, current: ["a"] });
    expect(result.added).toEqual(["a"]);
    expect(result.merged).toEqual(["a"]);
    expect(result.removedCount).toBe(0);
  });

  it("accepts an empty current", () => {
    const result = ok({ previous: ["a"], current: [] });
    expect(result.removed).toEqual(["a"]);
  });
});

describe("compareArrays with a key field", () => {
  const previous = [
    { id: 1, status: "ok" },
    { id: 2, status: "ok" },
    { id: 3, status: "ok" },
  ];

  it("detects changed, added and removed by key", () => {
    const current = [
      { id: 2, status: "paused" },
      { id: 3, status: "ok" },
      { id: 4, status: "ok" },
    ];
    const result = ok({ previous, current, keyField: "id" });
    expect(result.changed).toEqual([{ id: 2, status: "paused" }]);
    expect(result.previousChanged).toEqual([{ id: 2, status: "ok" }]);
    expect(result.unchanged).toEqual([{ id: 3, status: "ok" }]);
    expect(result.added).toEqual([{ id: 4, status: "ok" }]);
    expect(result.removed).toEqual([{ id: 1, status: "ok" }]);
    expect(result.changedCount).toBe(1);
  });

  it("merged keeps previous order, replaces changed, appends added", () => {
    const current = [
      { id: 4, status: "ok" },
      { id: 2, status: "paused" },
    ];
    const result = ok({ previous, current, keyField: "id" });
    expect(result.merged).toEqual([
      { id: 1, status: "ok" },
      { id: 2, status: "paused" },
      { id: 3, status: "ok" },
      { id: 4, status: "ok" },
    ]);
  });

  it("supports a nested key path", () => {
    const result = ok({
      previous: [{ meta: { id: "x" }, v: 1 }],
      current: [{ meta: { id: "x" }, v: 2 }],
      keyField: "meta.id",
    });
    expect(result.changed).toEqual([{ meta: { id: "x" }, v: 2 }]);
  });

  it("does not report key order as a change", () => {
    const result = ok({
      previous: [{ id: 1, a: 1, b: 2 }],
      current: [{ b: 2, a: 1, id: 1 }],
      keyField: "id",
    });
    expect(result.hasChanges).toBe(false);
  });

  it("first duplicate key wins on each side", () => {
    const result = ok({
      previous: [
        { id: 1, v: "old" },
        { id: 1, v: "ignored" },
      ],
      current: [
        { id: 1, v: "old" },
        { id: 1, v: "new" },
      ],
      keyField: "id",
    });
    expect(result.hasChanges).toBe(false);
  });

  it("fails with a 1-based index when an item has no key", () => {
    const error = fail({
      previous: [],
      current: [{ id: 1 }, { name: "x" }],
      keyField: "id",
    });
    expect(error).toContain("Current item 2");
    expect(fail({ previous: [1], current: [], keyField: "id" })).toContain(
      "Previous item 1"
    );
  });

  it("rejects a malformed key path", () => {
    expect(fail({ current: [], keyField: "a..b" })).toContain("empty part");
  });
});

describe("compareArrays bad input", () => {
  it("rejects a non-array current", () => {
    expect(fail({ current: { a: 1 } })).toContain(
      "Current must be a JSON array"
    );
    expect(fail({ current: undefined })).toContain("Current");
    expect(fail({ current: "" })).toContain("Current is required");
  });

  it("rejects a non-array previous", () => {
    expect(fail({ previous: 5, current: [] })).toContain("Previous");
  });

  it("rejects invalid JSON text", () => {
    expect(fail({ current: "[1," })).toContain("not valid JSON");
  });

  it("enforces the item limit", () => {
    const big = new Array(MAX_FILTER_ITEMS + 1).fill(1);
    expect(fail({ current: big })).toContain("the limit is");
    expect(fail({ previous: big, current: [] })).toContain("Previous");
  });
});

describe("compare-arrays definition", () => {
  it("is registered with the expected outputs and checks config", () => {
    const action = findActionById("data/compare-arrays");
    expect(action?.label).toBe("Compare Arrays");
    const outputs = action?.outputFields?.map((f) => f.field) ?? [];
    for (const name of [
      "added",
      "removed",
      "changed",
      "unchanged",
      "merged",
      "hasChanges",
    ]) {
      expect(outputs).toContain(name);
    }
  });

  it("checks typed config and skips templates", () => {
    expect(checkCompareArraysConfig({ keyField: "a..b" })?.field).toBe(
      "keyField"
    );
    expect(checkCompareArraysConfig({ current: "{ nope" })?.field).toBe(
      "current"
    );
    expect(
      checkCompareArraysConfig({
        previous: "{{@n:Get.value}}",
        current: "{{@m:X.items}}",
        keyField: "id",
      })
    ).toBeUndefined();
  });
});
