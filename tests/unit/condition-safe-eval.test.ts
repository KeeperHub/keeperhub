import { describe, expect, it } from "vitest";

import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";

const FAILS_RE =
  /not allowed|Unknown identifier|parse error|Property access|Unsupported|callable|Computed member/;

describe("safeEvaluateCondition - semantics", () => {
  describe("equality and comparison", () => {
    it("evaluates strict equality on context values", () => {
      expect(safeEvaluateCondition("__v0 === 5", { __v0: 5 })).toBe(true);
      expect(safeEvaluateCondition("__v0 === 5", { __v0: 6 })).toBe(false);
    });

    it("distinguishes loose == from strict === across types", () => {
      expect(safeEvaluateCondition('"0" == 0', {})).toBe(true);
      expect(safeEvaluateCondition('"0" === 0', {})).toBe(false);
      expect(safeEvaluateCondition('"0" != 0', {})).toBe(false);
      expect(safeEvaluateCondition('"0" !== 0', {})).toBe(true);
    });

    it("evaluates relational operators", () => {
      expect(safeEvaluateCondition("__v0 > 10", { __v0: 11 })).toBe(true);
      expect(safeEvaluateCondition("__v0 >= 10", { __v0: 10 })).toBe(true);
      expect(safeEvaluateCondition("__v0 < 10", { __v0: 9 })).toBe(true);
      expect(safeEvaluateCondition("__v0 <= 10", { __v0: 11 })).toBe(false);
    });

    it("evaluates arithmetic including exponentiation precedence", () => {
      expect(safeEvaluateCondition("2 + 3 * 4", {})).toBe(14);
      expect(safeEvaluateCondition("8 === 2 ** 3", {})).toBe(true);
      expect(safeEvaluateCondition("10 % 3", {})).toBe(1);
      expect(safeEvaluateCondition("(2 + 3) * 4", {})).toBe(20);
    });
  });

  describe("logical, unary, and ternary", () => {
    it("short-circuits && and || without evaluating the dead side", () => {
      // missingVar is an unknown identifier; it must not be evaluated.
      expect(safeEvaluateCondition("false && missingVar", {})).toBe(false);
      expect(safeEvaluateCondition("true || missingVar", {})).toBe(true);
    });

    it("evaluates && and || results", () => {
      expect(
        safeEvaluateCondition("__v0 && __v1", { __v0: true, __v1: 7 })
      ).toBe(7);
      expect(
        safeEvaluateCondition("__v0 || __v1", { __v0: 0, __v1: "x" })
      ).toBe("x");
    });

    it("evaluates unary operators", () => {
      expect(safeEvaluateCondition("!false", {})).toBe(true);
      expect(safeEvaluateCondition("-__v0 === -5", { __v0: 5 })).toBe(true);
      expect(safeEvaluateCondition("+__v0", { __v0: "3" })).toBe(3);
      expect(safeEvaluateCondition("typeof __v0", { __v0: "x" })).toBe(
        "string"
      );
    });

    it("evaluates ternary expressions", () => {
      expect(
        safeEvaluateCondition("__v0 ? __v1 : __v2", {
          __v0: true,
          __v1: "yes",
          __v2: "no",
        })
      ).toBe("yes");
      expect(
        safeEvaluateCondition("__v0 ? __v1 : __v2", {
          __v0: false,
          __v1: "yes",
          __v2: "no",
        })
      ).toBe("no");
    });
  });

  describe("member access", () => {
    it("reads nested members", () => {
      expect(
        safeEvaluateCondition("__v0.a.b === 1", { __v0: { a: { b: 1 } } })
      ).toBe(true);
    });

    it("reads computed members by index and string key", () => {
      expect(safeEvaluateCondition("__v0[0]", { __v0: [42] })).toBe(42);
      expect(
        safeEvaluateCondition('__v0["k"] === "v"', { __v0: { k: "v" } })
      ).toBe(true);
    });

    it("reads .length", () => {
      expect(
        safeEvaluateCondition("__v0.length === 3", { __v0: [1, 2, 3] })
      ).toBe(true);
    });
  });

  describe("allowlisted calls", () => {
    it("supports String() and string methods", () => {
      expect(
        safeEvaluateCondition('String(__v0).includes("00")', { __v0: 1002 })
      ).toBe(true);
      expect(
        safeEvaluateCondition('String(__v0).startsWith("ab")', { __v0: "abc" })
      ).toBe(true);
      expect(
        safeEvaluateCondition('String(__v0).endsWith("bc")', { __v0: "abc" })
      ).toBe(true);
      expect(
        safeEvaluateCondition("String(__v0).toLowerCase()", { __v0: "AB" })
      ).toBe("ab");
      expect(
        safeEvaluateCondition("String(__v0).trim()", { __v0: "  x  " })
      ).toBe("x");
    });

    it("supports Array.isArray and array methods", () => {
      expect(safeEvaluateCondition("Array.isArray(__v0)", { __v0: [] })).toBe(
        true
      );
      expect(safeEvaluateCondition("Array.isArray(__v0)", { __v0: 1 })).toBe(
        false
      );
      expect(
        safeEvaluateCondition("__v0.includes(2)", { __v0: [1, 2, 3] })
      ).toBe(true);
    });

    it("supports Object.keys with chained access", () => {
      expect(
        safeEvaluateCondition("Object.keys(__v0).length === 0", { __v0: {} })
      ).toBe(true);
      expect(
        safeEvaluateCondition('Object.keys(__v0).includes("id")', {
          __v0: { id: 1 },
        })
      ).toBe(true);
    });
  });

  describe("visual-builder operator expansions", () => {
    it("isEmpty / isNotEmpty", () => {
      const isEmpty = '(__v0 === null || __v0 === undefined || __v0 === "")';
      expect(safeEvaluateCondition(isEmpty, { __v0: "" })).toBe(true);
      expect(safeEvaluateCondition(isEmpty, { __v0: "x" })).toBe(false);
      const isNotEmpty = '(__v0 !== null && __v0 !== undefined && __v0 !== "")';
      expect(safeEvaluateCondition(isNotEmpty, { __v0: "x" })).toBe(true);
    });

    it("exists / doesNotExist", () => {
      const exists = "(__v0 !== null && __v0 !== undefined)";
      expect(safeEvaluateCondition(exists, { __v0: 0 })).toBe(true);
      const doesNotExist = "(__v0 === null || __v0 === undefined)";
      expect(safeEvaluateCondition(doesNotExist, { __v0: null })).toBe(true);
    });
  });

  describe("BigInt context", () => {
    it("compares BigInt context values exactly", () => {
      expect(
        safeEvaluateCondition("__v0 > __b0", {
          __v0: BigInt("2000000000000000000"),
          __b0: BigInt("1000000000000000000"),
        })
      ).toBe(true);
    });

    it("stringifies a BigInt receiver for includes()", () => {
      expect(
        safeEvaluateCondition('String(__v0).includes("000")', {
          __v0: BigInt("2000000000000000000"),
        })
      ).toBe(true);
    });
  });

  describe("numeric strings in relational comparisons", () => {
    // Template resolution hands the evaluator its values as strings, so the operands of a
    // relational comparison are usually strings even when the builder called the operator
    // numeric. These assert the documented contract rather than code-unit ordering.
    it("compares digit strings by magnitude, not by code unit", () => {
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "9", __v1: "10" })).toBe(true);
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "99", __v1: "100" })).toBe(true);
      expect(safeEvaluateCondition("__v0 > __v1", { __v0: "10", __v1: "9" })).toBe(true);
      expect(safeEvaluateCondition("__v0 >= __v1", { __v0: "9", __v1: "10" })).toBe(false);
    });

    it("compares across the MAX_SAFE_INTEGER boundary", () => {
      // 9007199254740991 is MAX_SAFE_INTEGER, so it does not trip needsBigIntMode and used
      // to be compared as text; 9007199254740992 is the first integer past it.
      const max = "9007199254740991";
      const past = "9007199254740992";
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: max, __v1: past })).toBe(true);
      expect(safeEvaluateCondition("__v0 > __v1", { __v0: max, __v1: past })).toBe(false);
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: max, __v1: max })).toBe(false);
      // Either side of the 15-to-16 digit step, which is where the old behaviour flipped.
      expect(
        safeEvaluateCondition("__v0 < __v1", {
          __v0: "999999999999999",
          __v1: "1000000000000000",
        })
      ).toBe(true);
    });

    it("keeps digit strings exact at wei scale", () => {
      expect(
        safeEvaluateCondition("__v0 < __v1", {
          __v0: "1000000000000000000",
          __v1: "1000000000000000001",
        })
      ).toBe(true);
    });

    it("compares decimal strings as numbers, in both regimes", () => {
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "9.5", __v1: "10.2" })).toBe(true);
      expect(safeEvaluateCondition("__v0 >= __v1", { __v0: "9.5", __v1: "10.2" })).toBe(
        false
      );
      // In BigInt mode a decimal string is left alone by applyBigIntConversion, so it used
      // to reach StringToBigInt and make both directions false at once.
      expect(
        safeEvaluateCondition("__v0 < __v1", { __v0: BigInt(10), __v1: "10.5" })
      ).toBe(true);
      expect(
        safeEvaluateCondition("__v0 >= __v1", { __v0: BigInt(10), __v1: "10.5" })
      ).toBe(false);
    });

    it("leaves equality, mixed types and non-numeric strings alone", () => {
      const addr = "0xAbC0000000000000000000000000000000000001";
      expect(safeEvaluateCondition("__v0 === __v1", { __v0: addr, __v1: addr })).toBe(true);
      expect(safeEvaluateCondition('__v0 == "9"', { __v0: "9" })).toBe(true);
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "9", __v1: 10 })).toBe(true);
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "apple", __v1: "banana" })).toBe(
        true
      );
      // Two points, so not a decimal: semver keeps the ordering it has today.
      expect(safeEvaluateCondition("__v0 < __v1", { __v0: "1.2.3", __v1: "1.10.0" })).toBe(
        false
      );
      expect(
        safeEvaluateCondition("__v0 < __v1", { __v0: "2026-09-05", __v1: "2026-10-01" })
      ).toBe(true);
    });
  });
});

describe("safeEvaluateCondition - security (must throw)", () => {
  const cases: Array<{
    name: string;
    expr: string;
    ctx: Record<string, unknown>;
  }> = [
    { name: "global fetch call", expr: 'fetch("http://x")', ctx: {} },
    {
      name: "computed constructor access",
      expr: '__v0["constructor"]',
      ctx: { __v0: {} },
    },
    {
      name: "unicode-escaped constructor access",
      expr: '__v0["\\u0063onstructor"]',
      ctx: { __v0: {} },
    },
    { name: "constructor on a literal", expr: "(1).constructor", ctx: {} },
    { name: "__proto__ access", expr: "__v0.__proto__", ctx: { __v0: {} } },
    { name: "prototype access", expr: "__v0.prototype", ctx: { __v0: {} } },
    { name: "array literal", expr: "[1,2,3]", ctx: {} },
    {
      name: "non-allowlisted method",
      expr: "__v0.toFixed(2)",
      ctx: { __v0: 1.234 },
    },
    { name: "globalThis identifier", expr: "globalThis", ctx: {} },
    { name: "process.env access", expr: "process.env", ctx: {} },
    { name: "setTimeout call", expr: "setTimeout(1, 1)", ctx: {} },
    {
      name: "constructor-of-constructor RCE chain",
      expr: '__v0["\\u0063onstructor"]["\\u0063onstructor"]("return 1")()',
      ctx: { __v0: {} },
    },
  ];

  for (const { name, expr, ctx } of cases) {
    it(`throws for ${name}`, () => {
      expect(() => safeEvaluateCondition(expr, ctx)).toThrow(FAILS_RE);
    });
  }

  it("does not invoke a global even if it exists in the host", () => {
    let called = false;
    const original = (globalThis as Record<string, unknown>).__keep787Probe;
    (globalThis as Record<string, unknown>).__keep787Probe = () => {
      called = true;
    };
    try {
      expect(() => safeEvaluateCondition("__keep787Probe()", {})).toThrow();
    } finally {
      (globalThis as Record<string, unknown>).__keep787Probe = original;
    }
    expect(called).toBe(false);
  });
});

describe("isSafeConditionExpression", () => {
  it("accepts allowlisted expressions (including generated var refs)", () => {
    expect(isSafeConditionExpression("true === true")).toBe(true);
    expect(isSafeConditionExpression("httpRequestResult.status === 200")).toBe(
      true
    );
    expect(
      isSafeConditionExpression(
        "(Array.isArray(itemsResult) && itemsResult.length > 0)"
      )
    ).toBe(true);
    expect(isSafeConditionExpression('String(bodyResult).includes("ok")')).toBe(
      true
    );
  });

  it("rejects injected or invalid expressions", () => {
    expect(isSafeConditionExpression('fetch("http://x")')).toBe(false);
    expect(isSafeConditionExpression('result["constructor"]')).toBe(false);
    expect(isSafeConditionExpression("[1,2,3]")).toBe(false);
    expect(isSafeConditionExpression("result.toFixed(2)")).toBe(false);
    expect(isSafeConditionExpression("{{@unresolved:Label.field}}")).toBe(
      false
    );
  });
});
