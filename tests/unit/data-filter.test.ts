import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import { MAX_FILTER_ITEMS } from "@/plugins/data/filter-config";
import {
  type FilterCoreInput,
  type FilterInput,
  filterStep,
} from "@/plugins/data/steps/filter";

type FilterSuccess = {
  success: true;
  items: unknown[];
  values: unknown[];
  indexes: number[];
  labels: unknown[];
  count: number;
  skipped: number;
  skippedIndexes: number[];
  skippedLabels: unknown[];
  missingReturn: number;
  total: number;
};

type FilterFailure = { success: false; error: string; errorClass?: string };

const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const CHAINLOG_NAMES = [
  "MCD_VAT",
  "EMSP_SPBEAM_HALT",
  "MCD_JUG",
  "EMSP_LINE_WIPE",
  "PIP_ETH",
];

const BATCH_RESULTS = [
  { success: true, result: false },
  { success: true, result: true },
  { success: false, result: null, error: "execution reverted" },
];

// Most cases test what each operator keeps, so they run in skip mode; the
// fail default has its own tests through runDefault.
async function run(
  input: FilterCoreInput
): Promise<FilterSuccess | FilterFailure> {
  return await runDefault({ untestable: "skip", ...input });
}

async function runDefault(
  input: FilterCoreInput
): Promise<FilterSuccess | FilterFailure> {
  return (await filterStep(input as FilterInput)) as
    | FilterSuccess
    | FilterFailure;
}

async function ok(input: FilterCoreInput): Promise<FilterSuccess> {
  const result = await run(input);
  if (!result.success) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result;
}

async function fails(input: FilterCoreInput): Promise<FilterFailure> {
  const result = await run(input);
  if (result.success) {
    throw new Error("expected a failure");
  }
  return result;
}

function source(value: unknown): string {
  return JSON.stringify(value);
}

describe("data/filter", () => {
  describe("the motivating examples", () => {
    it("keeps the Chainlog names that start with EMSP_", async () => {
      const result = await ok({
        source: source(CHAINLOG_NAMES),
        operator: "startsWith",
        value: "EMSP_",
      });
      expect(result.items).toEqual(["EMSP_SPBEAM_HALT", "EMSP_LINE_WIPE"]);
      expect(result.values).toEqual(["EMSP_SPBEAM_HALT", "EMSP_LINE_WIPE"]);
      expect(result.count).toBe(2);
      expect(result.total).toBe(5);
    });

    it("plucks result out of every batch-read result with Keep every item", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        operator: "keepAll",
        returnField: "result",
      });
      expect(result.values).toEqual([false, true, null]);
      expect(result.count).toBe(3);
    });

    it("counts the batch-read results whose result is true", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "isTrue",
      });
      expect(result.items).toEqual([BATCH_RESULTS[1]]);
      expect(result.count).toBe(1);
    });
  });

  describe("fields", () => {
    it("tests one field and returns another", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "success",
        operator: "isTrue",
        returnField: "result",
      });
      expect(result.values).toEqual([false, true]);
    });

    it("returns the tested field when Return field is blank", async () => {
      const result = await ok({
        source: source([{ meta: { name: "a" } }, { meta: { name: "b" } }]),
        field: "meta.name",
        operator: "===",
        value: "b",
      });
      expect(result.values).toEqual(["b"]);
      expect(result.items).toEqual([{ meta: { name: "b" } }]);
    });

    it("returns null in values when a matching item has no Return field", async () => {
      const result = await ok({
        source: source([{ ok: true, id: 1 }, { ok: true }]),
        field: "ok",
        operator: "isTrue",
        returnField: "id",
      });
      expect(result.values).toEqual([1, null]);
    });

    it("reads array indexes in a path", async () => {
      const result = await ok({
        source: source([{ topics: ["0xaa", "0xbb"] }, { topics: ["0xcc"] }]),
        field: "topics.1",
        operator: "exists",
      });
      expect(result.count).toBe(1);
    });
  });

  describe("missing fields", () => {
    const items = [{ name: "EMSP_X" }, { other: 1 }];

    it("does not match an item without the field for a comparison", async () => {
      const notEquals = await ok({
        source: source(items),
        field: "name",
        operator: "!==",
        value: "MCD_VAT",
      });
      expect(notEquals.items).toEqual([{ name: "EMSP_X" }]);

      // String(undefined) contains "def"; a missing field must not match it.
      const contains = await ok({
        source: source(items),
        field: "name",
        operator: "contains",
        value: "def",
      });
      expect(contains.count).toBe(0);
    });

    it("still matches presence tests on an item without the field", async () => {
      const cases: [string, number][] = [
        ["doesNotExist", 1],
        ["isUndefined", 1],
        ["isEmpty", 1],
        ["exists", 1],
        ["isNotUndefined", 1],
        ["isNotNull", 2],
      ];
      for (const [operator, expected] of cases) {
        const result = await ok({
          source: source(items),
          field: "name",
          operator,
        });
        expect(result.count, operator).toBe(expected);
      }
    });
  });

  describe("operators match Condition", () => {
    it("compares numbers by value, including text and uint256", async () => {
      const values = ["1", "1.0", 2, "10", UINT256_MAX];
      const greater = await ok({
        source: source(values),
        operator: ">",
        value: "9",
      });
      expect(greater.items).toEqual(["10", UINT256_MAX]);

      const equals = await ok({
        source: source(values),
        operator: "===",
        value: "1",
      });
      expect(equals.items).toEqual(["1", "1.0"]);

      const max = await ok({
        source: source(values),
        operator: "===",
        value: UINT256_MAX,
      });
      expect(max.items).toEqual([UINT256_MAX]);
    });

    it("keeps a quoted Value as text", async () => {
      const result = await ok({
        source: source([5, "5"]),
        operator: "==",
        value: '"5"',
      });
      expect(result.count).toBe(2);
      const strict = await ok({
        source: source(["true", true]),
        operator: "===",
        value: '"true"',
      });
      expect(strict.items).toEqual(["true"]);
    });

    it("runs the text operators", async () => {
      const words = ["alpha", "beta", "alphabet", ""];
      const cases: [string, string, unknown[]][] = [
        ["contains", "pha", ["alpha", "alphabet"]],
        ["startsWith", "be", ["beta"]],
        ["endsWith", "bet", ["alphabet"]],
      ];
      for (const [operator, value, expected] of cases) {
        const result = await ok({ source: source(words), operator, value });
        expect(result.items, operator).toEqual(expected);
      }
      const empty = await ok({ source: source(words), operator: "isEmpty" });
      expect(empty.items).toEqual([""]);
    });

    it("runs the boolean, array and object operators", async () => {
      const items = [
        { flag: true, list: [1, 2], obj: {} },
        { flag: false, list: [], obj: { key: 1 } },
        { flag: "true", list: [3], obj: { other: 1 } },
      ];
      const cases: [string, string, string | undefined, number[]][] = [
        ["flag", "isTrue", undefined, [0]],
        ["flag", "isFalse", undefined, [1]],
        ["list", "arrayIsEmpty", undefined, [1]],
        ["list", "arrayIsNotEmpty", undefined, [0, 2]],
        ["list", "arrayContains", "2", [0]],
        ["list", "arrayLength", "1", [2]],
        ["obj", "objectIsEmpty", undefined, [0]],
        ["obj", "objectHasKey", "key", [1]],
      ];
      for (const [field, operator, value, indexes] of cases) {
        const result = await ok({
          source: source(items),
          field,
          operator,
          value,
        });
        expect(result.items, operator).toEqual(indexes.map((i) => items[i]));
      }
    });
  });

  describe("Value from upstream data", () => {
    it("is compared as data, never evaluated as an expression", async () => {
      const result = await ok({
        source: source(CHAINLOG_NAMES),
        operator: "===",
        value: '"x" || "y"',
      });
      expect(result.count).toBe(0);
    });

    it("accepts a non-string Value from an MCP caller", async () => {
      const result = await ok({
        source: [1, 2, 3],
        operator: ">=",
        value: 2,
      });
      expect(result.items).toEqual([2, 3]);
    });
  });

  describe("failures", () => {
    it("refuses matches regex", async () => {
      const result = await fails({
        source: source(CHAINLOG_NAMES),
        operator: "matchesRegex",
        value: "^EMSP_",
      });
      expect(result.error).toContain("Matches regex is not supported");
      expect(result.errorClass).toBe("user");
    });

    it("refuses an unknown operator", async () => {
      const result = await fails({ source: "[1]", operator: "between" });
      expect(result.error).toContain('Unknown operator "between"');
    });

    it("needs a Value for a comparison", async () => {
      const result = await fails({
        source: "[1]",
        operator: "startsWith",
        value: "  ",
      });
      expect(result.error).toContain(
        'Value is required for "Text: starts with"'
      );
    });

    it("matches empty text when Value is quoted", async () => {
      const result = await ok({
        source: source(["", "a"]),
        operator: "===",
        value: '""',
      });
      expect(result.items).toEqual([""]);
    });

    it("needs the source to be an array", async () => {
      const object = await fails({
        source: source({ results: [] }),
        operator: "keepAll",
      });
      expect(object.error).toContain("Source must be a JSON array");

      const text = await fails({ source: "not json", operator: "keepAll" });
      expect(text.error).toContain("Source must be a JSON array");

      const blank = await fails({ source: "", operator: "keepAll" });
      expect(blank.error).toContain("Source is required");
    });

    it("caps the number of items", async () => {
      const over = await fails({
        source: source(new Array(MAX_FILTER_ITEMS + 1).fill(0)),
        operator: "keepAll",
      });
      expect(over.error).toContain("the limit is 10,000");

      const at = await ok({
        source: source(new Array(MAX_FILTER_ITEMS).fill(0)),
        operator: "===",
        value: "0",
      });
      expect(at.count).toBe(MAX_FILTER_ITEMS);
    });

    it("returns an empty match on an empty array", async () => {
      const result = await ok({ source: "[]", operator: "isTrue" });
      expect(result).toEqual({
        success: true,
        items: [],
        values: [],
        indexes: [],
        labels: [],
        count: 0,
        skipped: 0,
        skippedIndexes: [],
        skippedLabels: [],
        missingReturn: 0,
        total: 0,
      });
    });
  });

  describe("API and MCP callers", () => {
    it("requires Value when it is left out or null", async () => {
      for (const value of [undefined, null]) {
        const result = await fails({
          source: source(["a"]),
          operator: "contains",
          value,
        });
        expect(result.error, String(value)).toContain(
          'Value is required for "Text: contains"'
        );
      }
    });

    it("defaults a missing operator to equals", async () => {
      const result = await ok({ source: source([1, 2]), value: "1" });
      expect(result.items).toEqual([1]);
    });

    it("explains a non-text operator, field or return field", async () => {
      const operator = await fails({ source: "[1]", operator: 5 });
      expect(operator.error).toContain("Operator must be text");
      const field = await fails({
        source: "[1]",
        operator: "exists",
        field: true,
      });
      expect(field.error).toContain("Field to test must be text");
      const returned = await fails({
        source: "[1]",
        operator: "keepAll",
        returnField: true,
      });
      expect(returned.error).toContain("Return field must be text");
    });

    it("refuses a list or object as Value", async () => {
      for (const value of [{ a: 1 }, [1]]) {
        const result = await fails({ source: "[1]", operator: "===", value });
        expect(result.error).toContain("must be a single value");
      }
    });

    it("refuses an unclear ignoreCase", async () => {
      for (const ignoreCase of ["TRUE", 1, "yes"]) {
        const result = await fails({
          source: source(["a"]),
          operator: "===",
          value: "a",
          ignoreCase,
        });
        expect(result.error, String(ignoreCase)).toContain(
          "Ignore case must be true or false"
        );
      }
    });

    it("reads a boolean ignoreCase", async () => {
      const result = await ok({
        source: source(["ABC"]),
        operator: "===",
        value: "abc",
        ignoreCase: true,
      });
      expect(result.count).toBe(1);
    });
  });

  describe("text tests read Value as typed", () => {
    it("keeps leading and trailing zeros", async () => {
      const contains = await ok({
        source: source(["17", "a7", "x007"]),
        operator: "contains",
        value: "007",
      });
      expect(contains.items).toEqual(["x007"]);

      const ends = await ok({
        source: source(["x1.50", "x1.5"]),
        operator: "endsWith",
        value: "1.50",
      });
      expect(ends.items).toEqual(["x1.50"]);
    });

    it("matches a numeric object key", async () => {
      const result = await ok({
        source: source([{ 0: "a" }, { 1: "b" }]),
        operator: "objectHasKey",
        value: "0",
      });
      expect(result.items).toEqual([{ 0: "a" }]);
    });

    it("skips items that are not text or numbers", async () => {
      const result = await ok({
        source: source([null, true, { a: "obj" }, ["obj"], "object", 1]),
        operator: "contains",
        value: "o",
      });
      expect(result.items).toEqual(["object"]);
    });

    it("decodes escapes inside double quotes", async () => {
      const result = await ok({
        source: source(['a"b', 'a\\"b']),
        operator: "===",
        value: '"a\\"b"',
      });
      expect(result.items).toEqual(['a"b']);
    });
  });

  describe("number tests only match numbers", () => {
    const mixed = [null, "", " ", true, [2], { n: 1 }, 0, "5", "0x10", 7];

    it("never lets null, empty text, booleans or lists pass", async () => {
      const below = await ok({
        source: source(mixed),
        operator: "<",
        value: "1",
      });
      expect(below.items).toEqual([0]);
      const above = await ok({
        source: source(mixed),
        operator: ">",
        value: "-1",
      });
      expect(above.items).toEqual([0, "5", "0x10", 7]);
    });

    it("drops a failed batch read under a less-than test", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "<",
        value: "1",
      });
      expect(result.count).toBe(0);
    });

    it("compares hex by value on either side", async () => {
      const result = await ok({
        source: source(["0x10", "15", 17, "0xFF"]),
        operator: ">=",
        value: "0x10",
      });
      expect(result.items).toEqual(["0x10", 17, "0xFF"]);
    });

    it("needs a numeric Value", async () => {
      const result = await fails({
        source: "[1]",
        operator: ">",
        value: "abc",
      });
      expect(result.error).toContain(
        'Value for "Number: greater than" must be a number'
      );
    });
  });

  describe("object tests only match objects", () => {
    it("is empty keeps only empty plain objects", async () => {
      const result = await ok({
        source: source([{}, [], "", 0, null, { a: 1 }]),
        operator: "objectIsEmpty",
      });
      expect(result.items).toEqual([{}]);
    });
  });

  describe("Ignore case", () => {
    const addresses = ["0xAbCd", "0xabcd", "0x1234"];

    it("folds case for equality, text and array contains", async () => {
      const equals = await ok({
        source: source(addresses),
        operator: "===",
        value: "0xABCD",
        ignoreCase: "true",
      });
      expect(equals.items).toEqual(["0xAbCd", "0xabcd"]);

      const starts = await ok({
        source: source(["EMSP_A", "emsp_b", "MCD"]),
        operator: "startsWith",
        value: "emsp_",
        ignoreCase: "true",
      });
      expect(starts.items).toEqual(["EMSP_A", "emsp_b"]);

      const inList = await ok({
        source: source([{ owners: ["0xAbCd"] }, { owners: ["0x9"] }]),
        field: "owners",
        operator: "arrayContains",
        value: "0xabcd",
        ignoreCase: "true",
      });
      expect(inList.count).toBe(1);
    });

    it("is off unless set", async () => {
      const result = await ok({
        source: source(addresses),
        operator: "===",
        value: "0xABCD",
      });
      expect(result.count).toBe(0);
    });
  });

  describe("Keep every item", () => {
    it("ignores a Field to test left over from another operator", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "success",
        operator: "keepAll",
      });
      expect(result.values).toEqual(BATCH_RESULTS);
    });
  });

  describe("paths read own keys only", () => {
    it("does not reach inherited properties", async () => {
      const exists = await ok({
        source: source([{}, { a: 1 }]),
        field: "constructor",
        operator: "exists",
      });
      expect(exists.count).toBe(0);

      const plucked = await ok({
        source: source([{ a: 1 }]),
        operator: "keepAll",
        returnField: "toString",
      });
      expect(plucked.values).toEqual([null]);

      const proto = await ok({
        source: source([{ a: 1 }]),
        field: "__proto__",
        operator: "objectIsEmpty",
      });
      expect(proto.count).toBe(0);
    });
  });

  describe("the ticket's arrayContains follow-up", () => {
    it("feeds values into a Condition-style array contains", async () => {
      const plucked = await ok({
        source: source(BATCH_RESULTS),
        operator: "keepAll",
        returnField: "result",
      });
      const check = await ok({
        source: source([plucked.values]),
        operator: "arrayContains",
        value: "true",
      });
      expect(check.count).toBe(1);
    });
  });

  describe("round 1 fixes", () => {
    it("reports indexes and skipped", async () => {
      const result = await ok({
        source: source([
          { v: 5 },
          { other: 1 },
          { v: null },
          { v: 50 },
          { v: "abc" },
        ]),
        field: "v",
        operator: ">",
        value: "10",
      });
      expect(result.indexes).toEqual([3]);
      expect(result.values).toEqual([50]);
      expect(result.skipped).toBe(3);
      expect(result.total).toBe(5);
    });

    it("fails on an untestable item when set to, without echoing its content", async () => {
      const result = await fails({
        source: source([{ v: 1 }, { v: "SECRET-TEXT" }]),
        field: "v",
        operator: ">",
        value: "0",
        untestable: "fail",
      });
      expect(result.error).toContain(
        'Item at index 1 can\'t be tested with "Number: greater than": its value is text that is not a number.'
      );
      expect(result.error).not.toContain("SECRET-TEXT");

      const missing = await fails({
        source: source([{ other: 1 }]),
        field: "v",
        operator: "===",
        value: "1",
        untestable: "fail",
      });
      expect(missing.error).toContain("the field is missing");
    });

    it("refuses an unknown untestable mode", async () => {
      const result = await fails({
        source: "[1]",
        operator: "===",
        value: "1",
        untestable: "ignore",
      });
      expect(result.error).toContain('must be "skip" or "fail"');
    });

    it("never skips under keep every item or a presence test", async () => {
      const keep = await ok({
        source: source([null, {}]),
        operator: "keepAll",
      });
      expect(keep.skipped).toBe(0);
      const presence = await ok({
        source: source([{}, { v: 1 }]),
        field: "v",
        operator: "doesNotExist",
      });
      expect(presence).toMatchObject({ count: 1, skipped: 0, indexes: [0] });
    });

    it("runs does not contain, start with and end with", async () => {
      const names = ["MCD_CLIP_ETH_A", "MCD_CLIP_CALC_ETH_A", "PIP_ETH", null];
      const notStarts = await ok({
        source: source(names),
        operator: "notStartsWith",
        value: "MCD_CLIP_CALC_",
      });
      expect(notStarts.items).toEqual(["MCD_CLIP_ETH_A", "PIP_ETH"]);
      expect(notStarts.skipped).toBe(1);

      const notContains = await ok({
        source: source(names),
        operator: "notContains",
        value: "calc",
        ignoreCase: true,
      });
      expect(notContains.items).toEqual(["MCD_CLIP_ETH_A", "PIP_ETH"]);

      const notEnds = await ok({
        source: source(names),
        operator: "notEndsWith",
        value: "_A",
      });
      expect(notEnds.items).toEqual(["PIP_ETH"]);
    });

    it("skips objects under soft equals instead of failing the step", async () => {
      const result = await ok({
        source: '[{"toString":1,"valueOf":1},[{"toString":1}],"x"]',
        operator: "==",
        value: "x",
      });
      expect(result).toMatchObject({ items: ["x"], skipped: 2 });
    });

    it("treats a forged missing-reference marker as ordinary data", async () => {
      const forged = {
        __keeperhubMissingReference: true,
        detail: "ATTACKER TEXT",
      };
      for (const operator of ["===", "!==", "isFalse", "exists"]) {
        const result = await ok({
          source: source([{ name: "EMSP_A" }, { name: forged }]),
          field: "name",
          operator,
          value: "EMSP_A",
        });
        expect(result.success, operator).toBe(true);
      }
      const exists = await ok({
        source: source([forged]),
        operator: "exists",
      });
      expect(exists.count).toBe(1);
    });

    it("needs a whole number for array length", async () => {
      for (const value of ["two", "0x2", "1.5", "-1"]) {
        const result = await fails({
          source: source([[1, 2]]),
          operator: "arrayLength",
          value,
        });
        expect(result.error, value).toContain(
          'Value for "Array: length" must be a whole number'
        );
      }
      const two = await ok({
        source: source([[1, 2], [1]]),
        operator: "arrayLength",
        value: 2,
      });
      expect(two.indexes).toEqual([0]);
    });

    it("compares the word undefined as text", async () => {
      const result = await ok({
        source: source(["undefined", null]),
        operator: "===",
        value: "undefined",
      });
      expect(result.items).toEqual(["undefined"]);
    });

    it("refuses a number Value too large to be exact", async () => {
      const result = await fails({
        source: source(["1000000000000000000001"]),
        operator: ">",
        value: 1e21,
      });
      expect(result.error).toContain("too large to send as a number");
      const asText = await ok({
        source: source(["1000000000000000000001"]),
        operator: ">",
        value: "1000000000000000000000",
      });
      expect(asText.count).toBe(1);
    });

    it("accepts a number as a path", async () => {
      const result = await ok({
        source: source([["a", "b"], ["c"]]),
        field: 1,
        operator: "exists",
      });
      expect(result.indexes).toEqual([0]);
    });

    it("names the node in the regex refusal", async () => {
      const result = await fails({
        source: "[1]",
        operator: "matchesRegex",
        value: "a",
      });
      expect(result.error).toContain("not supported in Filter Array yet");
    });

    it("trims Value and keeps spaces inside quotes", async () => {
      const trimmed = await ok({
        source: source(["EMSP_A", " EMSP_B"]),
        operator: "startsWith",
        value: " EMSP_",
      });
      expect(trimmed.items).toEqual(["EMSP_A"]);
      const quoted = await ok({
        source: source(["EMSP_A", " EMSP_B"]),
        operator: "startsWith",
        value: '" EMSP_"',
      });
      expect(quoted.items).toEqual([" EMSP_B"]);
    });

    it("leaves Ignore case off number tests and has key", async () => {
      const key = await ok({
        source: source([{ Owner: 1 }]),
        operator: "objectHasKey",
        value: "owner",
        ignoreCase: true,
      });
      expect(key.count).toBe(0);
      const loose = await ok({
        source: source(["ABC", "x"]),
        operator: "!=",
        value: "abc",
        ignoreCase: true,
      });
      expect(loose.items).toEqual(["x"]);
    });

    it("compares loosely under soft equals, as documented", async () => {
      const result = await ok({
        source: source(["0x01", 1, true, "1", "2", 0]),
        operator: "==",
        value: "1",
      });
      expect(result.items).toEqual(["0x01", 1, true, "1"]);
      const le = await ok({
        source: source([1, "2", 3, "0x2"]),
        operator: "<=",
        value: "2",
      });
      expect(le.items).toEqual([1, "2", "0x2"]);
    });
  });

  describe("round 2 fixes", () => {
    it("counts a reverted batch read as skipped under is true", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "isTrue",
      });
      expect(result).toMatchObject({ count: 1, skipped: 1, indexes: [1] });
    });

    it("fails on a reverted read when set to fail", async () => {
      const result = await fails({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "isTrue",
        untestable: "fail",
      });
      expect(result.error).toContain(
        'Item at index 2 can\'t be tested with "Boolean: is true": its value is null, not true or false.'
      );
    });

    it("only tests booleans under is true and is false", async () => {
      const result = await ok({
        source: source([true, false, "true", "false", 1, 0, null, {}]),
        operator: "isFalse",
      });
      expect(result).toMatchObject({ indexes: [1], skipped: 6 });
    });

    it("puts the label of each match in labels", async () => {
      const result = await ok({
        source: source([{ result: "0" }, { result: "2" }, { result: "1" }]),
        field: "result",
        operator: ">",
        value: "0",
        labels: source([
          "MCD_CLIP_ETH_A",
          "MCD_CLIP_WBTC_A",
          "MCD_CLIP_LINK_A",
        ]),
      });
      expect(result.labels).toEqual(["MCD_CLIP_WBTC_A", "MCD_CLIP_LINK_A"]);
      expect(result.indexes).toEqual([1, 2]);
    });

    it("leaves labels empty when Labels is not set", async () => {
      const result = await ok({ source: "[1]", operator: "keepAll" });
      expect(result.labels).toEqual([]);
    });

    it("needs Labels to line up with Source", async () => {
      const short = await fails({
        source: "[1, 2, 3]",
        operator: "keepAll",
        labels: '["a", "b"]',
      });
      expect(short.error).toContain(
        "Labels has 2 entries but Source has 3; they must line up one to one."
      );
      const notArray = await fails({
        source: "[1]",
        operator: "keepAll",
        labels: '{"a": 1}',
      });
      expect(notArray.error).toContain("Labels must be a JSON array");
    });

    it("counts matches without the Return field, and fails on them when set to", async () => {
      const items = source([{ ok: true, result: 1 }, { ok: true }]);
      const counted = await ok({
        source: items,
        field: "ok",
        operator: "isTrue",
        returnField: "reslt",
      });
      expect(counted).toMatchObject({ count: 2, missingReturn: 2 });
      expect(counted.values).toEqual([null, null]);

      const failed = await fails({
        source: items,
        field: "ok",
        operator: "isTrue",
        returnField: "result",
        missingReturn: "fail",
      });
      expect(failed.error).toContain(
        'Item at index 1 matched but has no Return field "result".'
      );
    });

    it("ignores settings the form hides for the chosen operator", async () => {
      const unary = await ok({
        source: source([true]),
        operator: "isTrue",
        ignoreCase: "yes",
      });
      expect(unary.count).toBe(1);
      const keep = await ok({
        source: "[1]",
        operator: "keepAll",
        untestable: "nope",
        field: ["x"],
      });
      expect(keep.count).toBe(1);
    });

    it("explains a non-finite number Value", async () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = await fails({ source: "[1]", operator: "===", value });
        expect(result.error).toContain("must be a finite number");
      }
    });

    it("caps the length of a number Value", async () => {
      const result = await fails({
        source: "[1]",
        operator: ">",
        value: "9".repeat(101),
      });
      expect(result.error).toContain("longer than 100 characters");
      const fits = await ok({
        source: source(["9".repeat(100)]),
        operator: ">=",
        value: "9".repeat(100),
      });
      expect(fits.count).toBe(1);
    });

    it("keeps numbers under does not start with", async () => {
      const result = await ok({
        source: source(["EMSP_A", 123, "X"]),
        operator: "notStartsWith",
        value: "EMSP",
      });
      expect(result.items).toEqual([123, "X"]);
    });

    it("keeps nothing under does not contain an empty text", async () => {
      const result = await ok({
        source: source(["a", "b"]),
        operator: "notContains",
        value: '""',
      });
      expect(result.count).toBe(0);
    });

    it("reports positions in a sparse source", async () => {
      const result = await ok({
        source: [1, undefined, 3],
        operator: "exists",
      });
      expect(result.indexes).toEqual([0, 2]);
    });
  });

  describe("round 3 fixes", () => {
    it("fails on an untestable item by default", async () => {
      const result = await runDefault({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "isTrue",
      });
      expect(result).toMatchObject({ success: false });
      expect((result as FilterFailure).error).toContain(
        "Item at index 2 can't be tested"
      );
    });

    it("names the skipped items in skip mode", async () => {
      const result = await ok({
        source: source(BATCH_RESULTS),
        field: "result",
        operator: "isTrue",
        labels: '["EMSP_A", "EMSP_B", "EMSP_C"]',
      });
      expect(result).toMatchObject({
        labels: ["EMSP_B"],
        skippedIndexes: [2],
        skippedLabels: ["EMSP_C"],
      });
    });

    it("keeps skippedLabels empty without Labels", async () => {
      const result = await ok({
        source: source([1, null]),
        operator: ">",
        value: "0",
      });
      expect(result).toMatchObject({
        skippedIndexes: [1],
        skippedLabels: [],
      });
    });

    it("lets a missing Return field fail even where untestable is hidden", async () => {
      const result = await runDefault({
        source: source([{ a: 1 }]),
        operator: "keepAll",
        returnField: "b",
        missingReturn: "fail",
      });
      expect((result as FilterFailure).error).toContain(
        'matched but has no Return field "b"'
      );
      const kept = await ok({
        source: source([{ a: 1 }]),
        operator: "keepAll",
        returnField: "b",
      });
      expect(kept).toMatchObject({ values: [null], missingReturn: 1 });
    });

    it("refuses an unknown missing Return field mode", async () => {
      const result = await fails({
        source: "[1]",
        operator: "keepAll",
        missingReturn: "drop",
      });
      expect(result.error).toContain('must be "keep" or "fail"');
    });

    it("refuses a path with an empty part", async () => {
      for (const [key, name] of [
        ["field", "Field to test"],
        ["returnField", "Return field"],
      ]) {
        const result = await fails({
          source: "[1]",
          operator: "exists",
          [key]: "a..b",
        });
        expect(result.error, key).toContain(`${name} has an empty part`);
      }
    });

    it("gives a tip that fits the test when Value is missing", async () => {
      const cases: [string, string][] = [
        [">", "Enter a number, e.g. 100 or 0x64."],
        ["arrayLength", "Enter a whole number, e.g. 3."],
        ["objectHasKey", "Enter the key to look for."],
        ["startsWith", 'To match empty text, enter "".'],
      ];
      for (const [operator, tip] of cases) {
        const result = await fails({ source: "[1]", operator, value: "" });
        expect(result.error, operator).toContain(tip);
      }
    });

    it("refuses an array length too large to be exact", async () => {
      const result = await fails({
        source: "[[1]]",
        operator: "arrayLength",
        value: "9".repeat(400),
      });
      expect(result.error).toContain("must be a whole number");
    });
  });

  describe("round 4 fixes", () => {
    it("shortens a long unknown operator in the message", async () => {
      const result = await fails({ source: "[1]", operator: "x".repeat(5000) });
      expect(result.error.length).toBeLessThan(200);
      expect(result.error).toContain(`Unknown operator "${"x".repeat(60)}..."`);
    });

    it("caps the length of a path", async () => {
      const result = await fails({
        source: "[1]",
        operator: "exists",
        field: "a".repeat(501),
      });
      expect(result.error).toContain(
        "Field to test is longer than 500 characters"
      );
    });

    it("asks for a whole number, not text, for a huge array length", async () => {
      const result = await fails({
        source: "[[1]]",
        operator: "arrayLength",
        value: 1e300,
      });
      expect(result.error).toContain(
        "must be a whole number up to 9,007,199,254,740,991, e.g. 3."
      );
      expect(result.error).not.toContain("Send it as text");
    });
  });

  describe("round 5 fixes", () => {
    it("says entry for a single label", async () => {
      const result = await fails({
        source: "[1, 2]",
        operator: "keepAll",
        labels: '["a"]',
      });
      expect(result.error).toContain("Labels has 1 entry but Source has 2");
    });
  });

  describe("Value read as a number or kept as text", () => {
    it("compares a long decimal Value exactly, without rounding it", async () => {
      const value = "0.1000000000000000000001";
      const equal = await ok({
        source: '["0.1", "0.1000000000000000000001"]',
        operator: "===",
        value,
      });
      expect(equal.indexes).toEqual([1]);
      const notEqual = await ok({
        source: '["0.1", "0.1000000000000000000001"]',
        operator: "!==",
        value,
      });
      expect(notEqual.indexes).toEqual([0]);
    });

    it("reads an exact decimal written any way as a number", async () => {
      for (const value of ["1.50", "+1.5", "001.5"]) {
        const result = await ok({
          source: '[[1.5], ["1.50"]]',
          operator: "arrayContains",
          value,
        });
        expect(result.indexes, value).toEqual([0]);
      }
      const tiny = await ok({
        source: "[1e-7, 2e-7]",
        operator: "===",
        value: "0.0000001",
      });
      expect(tiny.indexes).toEqual([0]);
      const notTiny = await ok({
        source: "[1e-7, 2e-7]",
        operator: "!==",
        value: "0.0000001",
      });
      expect(notTiny.indexes).toEqual([1]);
    });

    it("still reads a plain number Value as a number", async () => {
      const result = await ok({
        source: '[5, "5", 6]',
        operator: "===",
        value: "5",
      });
      expect(result.indexes).toEqual([0, 1]);
    });

    it("leaves labels and skippedLabels empty without Labels", async () => {
      const result = await ok({
        source: "[true, null, false]",
        operator: "isTrue",
      });
      expect(result).toMatchObject({
        labels: [],
        skippedLabels: [],
        skipped: 1,
      });
    });
  });
});
