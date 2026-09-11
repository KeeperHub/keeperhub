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

    it("distinguishes loose == from strict === outside numbers", () => {
      // Both operators read a numeric pair by magnitude, so "0" and 0 are the
      // same value to either one. That is deliberate: the visual builder emits
      // a typed number bare and template resolution hands the other side over
      // as a string, so a rule an author builds is usually exactly this pair,
      // and === answering false to it made "equals" unusable in the UI.
      expect(safeEvaluateCondition('"0" == 0', {})).toBe(true);
      expect(safeEvaluateCondition('"0" === 0', {})).toBe(true);
      expect(safeEvaluateCondition('"0" != 0', {})).toBe(false);
      expect(safeEvaluateCondition('"0" !== 0', {})).toBe(false);

      // What still separates them is every pair that is not two numbers.
      expect(safeEvaluateCondition('"" == 0', {})).toBe(true);
      expect(safeEvaluateCondition('"" === 0', {})).toBe(false);
      expect(safeEvaluateCondition("__v0 == 1", { __v0: true })).toBe(true);
      expect(safeEvaluateCondition("__v0 === 1", { __v0: true })).toBe(false);
      expect(safeEvaluateCondition("null == undefined", {})).toBe(true);
      expect(safeEvaluateCondition("null === undefined", {})).toBe(false);
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
    // Template resolution hands the evaluator its values as strings, so the
    // operands of a relational comparison are usually strings even when the
    // builder called the operator numeric. These assert the documented
    // contract rather than code-unit ordering.
    const cmp = (operator: string, a: unknown, b: unknown) =>
      safeEvaluateCondition(`__v0 ${operator} __v1`, { __v0: a, __v1: b });
    const lt = (a: unknown, b: unknown) => cmp("<", a, b);
    const gt = (a: unknown, b: unknown) => cmp(">", a, b);
    const lte = (a: unknown, b: unknown) => cmp("<=", a, b);
    const gte = (a: unknown, b: unknown) => cmp(">=", a, b);

    it("compares digit strings by magnitude, not by code unit", () => {
      // All under MAX_SAFE_INTEGER, so needsBigIntMode is false and
      // applyBigIntConversion leaves them as strings: the evaluator is the
      // only thing that can order them.
      expect(lt("9", "10")).toBe(true);
      expect(lt("99", "100")).toBe(true);
      expect(gt("10", "9")).toBe(true);
      expect(gte("9", "10")).toBe(false);
      expect(lt("999999999999999", "1000000000000000")).toBe(true);
    });

    it("orders signed operands, whichever side carries the sign", () => {
      expect(lt("-5", "-3")).toBe(true);
      expect(gt("-5", "-3")).toBe(false);
      expect(lt("-5", "3")).toBe(true);
      expect(lt("+5", "10")).toBe(true);
      expect(gt("+5", "3")).toBe(true);
      expect(lt("-0", "0")).toBe(false);
    });

    it("keeps a decimal exact past the double precision limit", () => {
      // Number() rounds the left operand to 1e18 and calls these equal.
      expect(gt("1000000000000000000.5", "1000000000000000000")).toBe(true);
      expect(lt("1000000000000000000", "1000000000000000000.5")).toBe(true);
      expect(gt("0.30000000000000004", "0.3")).toBe(true);
    });

    it("compares decimals through every relational operator", () => {
      expect(lt("9.5", "10.2")).toBe(true);
      expect(gt("10.2", "9.5")).toBe(true);
      expect(lte("9.5", "9.5")).toBe(true);
      expect(lte("10.2", "9.5")).toBe(false);
      expect(gte("9.5", "10.2")).toBe(false);
      // A decimal string in BigInt mode used to reach StringToBigInt, which
      // rejects the point and made both directions false at once.
      expect(lt(BigInt(10), "10.5")).toBe(true);
      expect(gte(BigInt(10), "10.5")).toBe(false);
    });

    it("moves neither operand unless both are decimals", () => {
      // A hex or address-shaped operand is not a decimal, so the pair keeps
      // the code-unit ordering it has today instead of reversing once the
      // other side has become a BigInt.
      const addr = "0x0000000000000000000000000000000000000002";
      expect(lt("1", addr)).toBe(false);
      expect(gt("1", addr)).toBe(true);
      expect(lt("10", "0x1f")).toBe(false);
      // Exponent notation is outside the grammar the builder emits bare.
      expect(lt("1e3", "9")).toBe(true);
      // Surrounding whitespace and the empty string are not decimals either.
      expect(lt(" 9", "10")).toBe(true);
      expect(lt("", "0")).toBe(true);
    });

    it("keeps a digit string orderable against a word", () => {
      // The trap this avoids: with one side converted and the other coerced
      // by the engine, <, > and === are all false at once, and no set of
      // branches an author can write is exhaustive.
      expect(lt("9", "apple")).toBe(true);
      expect(gt("9", "apple")).toBe(false);
      expect(cmp("===", "9", "apple")).toBe(false);
    });

    it("leaves non-string operands to the operator", () => {
      expect(lt("9", null)).toBe(false);
      expect(gt("9", null)).toBe(true);
      expect(lt("9", true)).toBe(false);
      expect(lt("0", true)).toBe(true);
      // A number is a decimal too, so these two are compared by magnitude
      // here rather than left to the operator. The first pair would otherwise
      // put the string through ToNumber, which is where precision goes.
      expect(lt("9", 9.5)).toBe(true);
      expect(lt(BigInt(10), 10.5)).toBe(true);
      expect(gt("9007199254740993", 9_007_199_254_740_992)).toBe(true);
    });

    it("leaves a pair that is not two decimals alone", () => {
      const addr = "0xAbC0000000000000000000000000000000000001";
      expect(cmp("===", addr, addr)).toBe(true);
      expect(safeEvaluateCondition('__v0 == "9"', { __v0: "9" })).toBe(true);
      expect(lt("apple", "banana")).toBe(true);
      // Two points, so not a decimal: semver keeps today's ordering. Two
      // components do match the grammar, though, and are read as decimals.
      expect(lt("1.2.3", "1.10.0")).toBe(false);
      expect(lt("1.10", "1.9")).toBe(true);
      expect(lt("2026-09-05", "2026-10-01")).toBe(true);
      // Spelled-out numbers are strings like any other.
      expect(lt("Infinity", "9")).toBe(false);
      expect(gt("Infinity", "9")).toBe(true);
      expect(cmp("===", "NaN", "NaN")).toBe(true);
      expect(cmp("===", Number.NaN, Number.NaN)).toBe(false);
    });

    it("orders digit strings either side of the double limit", () => {
      // 1e18 against 1e18 + 1. ToNumber gives both operands the same double,
      // which is the comparison the issue was filed for, and neither operand
      // reaches applyBigIntConversion when the test calls the evaluator
      // directly. The 16th digit is the one that has to survive.
      expect(lt("1000000000000000000", "1000000000000000001")).toBe(true);
      expect(gt("1000000000000000001", "1000000000000000000")).toBe(true);
      expect(gte("1000000000000000000", "1000000000000000001")).toBe(false);
      expect(cmp("===", "1000000000000000000", "1000000000000000001")).toBe(
        false
      );
    });

    it("answers exactly one of <, > and === for pairs it reads as decimals", () => {
      // Ordering numeric with equality still textual left all three false at
      // once for a pair that is equal by magnitude and different as text, so
      // a Condition branching on <, > and === took no branch at all. These
      // are the shapes a formatter and an author produce between them.
      const equalPairs: [unknown, unknown][] = [
        ["1", "1.0"],
        ["1000000000000000000", "1000000000000000000.0"],
        ["007", "7"],
        ["0.5", "0.50"],
        ["-0", "0"],
        ["+1", "1"],
        ["100", 100],
        ["1.5", 1.5],
        [BigInt(9), "9"],
      ];
      for (const [a, b] of equalPairs) {
        // The operands ride along so a failure names the pair that broke.
        expect([String(a), lt(a, b), gt(a, b), cmp("===", a, b)]).toEqual([
          String(a),
          false,
          false,
          true,
        ]);
        expect(cmp("!==", a, b)).toBe(false);
        expect(cmp("==", a, b)).toBe(true);
        expect(cmp("!=", a, b)).toBe(false);
      }

      // And an unequal pair still answers exactly one, on the other side.
      const lesser: [unknown, unknown][] = [
        ["9", "10"],
        ["1000000000000000000", "1000000000000000001"],
        ["007", "8"],
        ["-5", "-3"],
        ["1.10", "1.9"],
      ];
      for (const [a, b] of lesser) {
        expect([String(a), lt(a, b), gt(a, b), cmp("===", a, b)]).toEqual([
          String(a),
          true,
          false,
          false,
        ]);
      }
    });

    it("orders two digit strings by magnitude at any length", () => {
      // A uint256 is 78 digits and the same value formatted with 18 decimals
      // is 97 characters, so a read never produces operands this long.
      const uint256Max = "1".repeat(78);
      expect(lt(uint256Max, `9${uint256Max.slice(1)}`)).toBe(true);
      expect(lt("9".repeat(256), `1${"0".repeat(256)}`)).toBe(true);

      // 258 characters against 259. An earlier revision capped each operand on
      // its own, so the shorter side converted, the longer one did not, and
      // the pair fell through to code-unit ordering and answered backwards:
      // 10^258 - 1 is less than 10^258, and "9" sorts after "1".
      expect(lt("9".repeat(258), `1${"0".repeat(258)}`)).toBe(true);
      expect(gt("9".repeat(258), `1${"0".repeat(258)}`)).toBe(false);

      // Far past that boundary, and across two spellings of one value. Nothing
      // is parsed into a BigInt, so length costs a comparison rather than the
      // square of one: measured here, a 1,000,000-digit pair is 0.006 ms
      // ordered as digits against 349 ms parsed first.
      const nines = "9".repeat(300);
      const larger = `1${"0".repeat(300)}`;
      expect(lt(nines, larger)).toBe(true);
      expect(gt(nines, larger)).toBe(false);
      expect(cmp("===", nines, larger)).toBe(false);
      expect(cmp("===", nines, `${nines}.0`)).toBe(true);
      expect(cmp("===", nines, `0000${nines}`)).toBe(true);
    });

    it("hands back a BigInt too large to print, and nothing reverses", () => {
      // Printing a BigInt is superlinear - 132 ms at 300,000 digits - so past
      // 10^256 the operand is handed back unprinted. The pair then falls back
      // to JavaScript's own BigInt comparison, which converts the string and
      // is exact, so declining to convert changes no answer here.
      const beyond = BigInt(`1${"0".repeat(300)}`);
      expect(lt(beyond, "9".repeat(301))).toBe(true);
      expect(gt(beyond, "9".repeat(301))).toBe(false);
      expect(gt(beyond, "1")).toBe(true);

      // Inside the bound it is printed and read as a decimal, so a BigInt and
      // the string spelling of the same value are one value.
      expect(cmp("===", 10n ** 200n, `1${"0".repeat(200)}`)).toBe(true);
      expect(cmp("===", 10n ** 200n, `1${"0".repeat(200)}.00`)).toBe(true);
      expect(cmp("===", -(10n ** 200n), `-1${"0".repeat(200)}`)).toBe(true);
    });

    it("holds the example the operator page gives for == against ===", () => {
      // docs/workflows/creating.md tells an author the two operators part
      // company only where one side is not a number. The page said the
      // opposite until this change, so the example it now gives is asserted
      // here rather than left to drift a second time.
      expect(cmp("==", "0", false)).toBe(true);
      expect(cmp("===", "0", false)).toBe(false);
      expect(cmp("===", "0", 0)).toBe(true);
      expect(cmp("===", "1.0", 1)).toBe(true);
      expect(cmp("===", "1.0", "1")).toBe(true);
    });

    it("leaves a pair outside the decimal grammar where it was", () => {
      // The invariant above is the decimal grammar's, not every numeric-looking
      // pair's. Exponent and hex forms are outside it by construction - the
      // visual builder quotes them rather than emitting a bare number - and so
      // is anything carrying whitespace. For these the evaluator hands the pair
      // back, all three answers are false at once, and an author branching on
      // <, > and === takes no branch. None of it is a regression: each answers
      // the same way on staging. It is recorded so the next reader does not
      // take the name of the test above to mean more than it does.
      const outside: [unknown, unknown][] = [
        [1e21, "1000000000000000000000"],
        [1e-7, "0.0000001"],
        [" 1", 1],
        ["0x10", 16],
        ["pending", 5],
      ];
      for (const [a, b] of outside) {
        expect([String(a), lt(a, b), gt(a, b), cmp("===", a, b)]).toEqual([
          String(a),
          false,
          false,
          false,
        ]);
      }
    });

    it("reads a negative decimal by magnitude and gives zero no sign", () => {
      expect(cmp("===", "-1.5", "-1.50")).toBe(true);
      expect(cmp("===", "-0.0", "0")).toBe(true);
      expect(cmp("===", "-0", "0.000")).toBe(true);
      expect(lt("-2", "-1")).toBe(true);
      expect(gt("-2", "-1")).toBe(false);
      expect(lt("-0.2", "-0.10")).toBe(true);
      expect(lt("-1", "0")).toBe(true);
      expect(gt("1", "-1")).toBe(true);
      expect(lt("-1.5", -1.4)).toBe(true);
    });

    it("leaves a missing or absent operand where it was", () => {
      // undefined is not a decimal, so both sides keep the answer they have
      // always had. Against itself that is equality; against a string it is
      // ToNumber and NaN, which is false in every direction. That predates
      // this change and is plain JavaScript, not something decimals reach.
      expect(cmp("===", undefined, undefined)).toBe(true);
      expect(cmp("!==", undefined, undefined)).toBe(false);
      expect(lt(undefined, "9")).toBe(false);
      expect(gt(undefined, "9")).toBe(false);
      expect(cmp("===", undefined, "9")).toBe(false);
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
