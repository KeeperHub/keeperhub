import { describe, expect, it } from "vitest";
import {
  applyBigIntConversion,
  needsBigIntMode,
} from "@/lib/bigint-condition-utils";

describe("needsBigIntMode", () => {
  describe("returns true when large integers are present", () => {
    it("should detect large integer string in evalContext", () => {
      const result = needsBigIntMode("__v0 > 100", {
        __v0: "9007199254740993",
      });
      expect(result).toBe(true);
    });

    it("should detect large number value in evalContext", () => {
      const result = needsBigIntMode("__v0 > 100", {
        // biome-ignore lint/correctness/noPrecisionLoss: intentionally testing with unsafe number to verify detection
        __v0: 9_007_199_254_740_993,
      });
      expect(result).toBe(true);
    });

    it("should detect large number literal in expression", () => {
      const result = needsBigIntMode("__v0 > 9007199254740993", {
        __v0: "100",
      });
      expect(result).toBe(true);
    });

    it("should detect MAX_SAFE_INTEGER + 1 in context", () => {
      const result = needsBigIntMode("__v0 === 0", {
        __v0: "9007199254740992",
      });
      expect(result).toBe(true);
    });
  });

  describe("returns false for safe values", () => {
    it("should return false for small integers", () => {
      const result = needsBigIntMode("__v0 > 100", { __v0: 500 });
      expect(result).toBe(false);
    });

    it("should return false for small integer strings", () => {
      const result = needsBigIntMode("__v0 > 100", { __v0: "500" });
      expect(result).toBe(false);
    });

    it("should return false for non-numeric strings", () => {
      const result = needsBigIntMode('__v0 === "hello"', {
        __v0: "hello",
      });
      expect(result).toBe(false);
    });

    it("should return false for booleans", () => {
      const result = needsBigIntMode("__v0 === true", { __v0: true });
      expect(result).toBe(false);
    });

    it("should return false for floating point numbers", () => {
      const result = needsBigIntMode("__v0 > 3.14", { __v0: 2.71 });
      expect(result).toBe(false);
    });

    it("should return false for MAX_SAFE_INTEGER exactly", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: "9007199254740991",
      });
      expect(result).toBe(false);
    });

    it("should return false for null values", () => {
      const result = needsBigIntMode("__v0 === null", { __v0: null });
      expect(result).toBe(false);
    });

    it("should return false for undefined values", () => {
      const result = needsBigIntMode("__v0 === undefined", {
        __v0: undefined,
      });
      expect(result).toBe(false);
    });

    it("should return false for strings with mixed digits and letters", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: "31231231nfsdf",
      });
      expect(result).toBe(false);
    });

    it("should return false for strings with leading zeros and letters", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: "0x1234567890abcdef",
      });
      expect(result).toBe(false);
    });

    it("should return false for empty string", () => {
      const result = needsBigIntMode("__v0 > 0", { __v0: "" });
      expect(result).toBe(false);
    });

    it("should return false for negative number strings", () => {
      const result = needsBigIntMode("__v0 > 0", { __v0: "-100" });
      expect(result).toBe(false);
    });

    it("should return false for decimal string", () => {
      const result = needsBigIntMode("__v0 > 0", { __v0: "3.14" });
      expect(result).toBe(false);
    });

    it("should return false for NaN", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: Number.NaN,
      });
      expect(result).toBe(false);
    });

    it("should return false for Infinity", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: Number.POSITIVE_INFINITY,
      });
      expect(result).toBe(false);
    });

    it("should return false for array values", () => {
      const result = needsBigIntMode("__v0 > 0", {
        __v0: [1, 2, 3],
      });
      expect(result).toBe(false);
    });
  });

  describe("quoted string handling", () => {
    it("should not detect large numbers inside quoted strings in expression", () => {
      const result = needsBigIntMode(
        '__v0 === "412123123123124124124124134123"',
        { __v0: 100 }
      );
      expect(result).toBe(false);
    });

    it("should detect large number in context even if expression has quoted string", () => {
      const result = needsBigIntMode('__v0 === "hello"', {
        __v0: "412123123123124124124124134123",
      });
      expect(result).toBe(true);
    });

    it("should not detect large numbers inside single-quoted strings", () => {
      const result = needsBigIntMode("__v0 === '9007199254740993'", {
        __v0: 100,
      });
      expect(result).toBe(false);
    });
  });

  describe("expression-only detection", () => {
    it("should detect large literal even with empty context", () => {
      const result = needsBigIntMode("__v0 > 9007199254740993", {});
      expect(result).toBe(true);
    });

    it("should not detect safe literals in expression", () => {
      const result = needsBigIntMode("__v0 > 100 && __v0 < 200", {});
      expect(result).toBe(false);
    });
  });
});

describe("applyBigIntConversion", () => {
  describe("context value conversion", () => {
    it("should convert digit-only string to BigInt", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "2000000000000000000",
      });
      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));
    });

    it("should convert integer number to BigInt", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: 100,
      });
      expect(evalContext.__v0).toBe(BigInt(100));
    });

    it("should convert small integer strings to BigInt too", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "42",
      });
      expect(evalContext.__v0).toBe(BigInt(42));
    });

    it("should leave non-numeric strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 === __v1", {
        __v0: "hello",
      });
      expect(evalContext.__v0).toBe("hello");
    });

    it("should leave booleans unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 === true", {
        __v0: true,
      });
      expect(evalContext.__v0).toBe(true);
    });

    it("should leave null unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 === null", {
        __v0: null,
      });
      expect(evalContext.__v0).toBeNull();
    });

    it("should leave objects unchanged", () => {
      const obj = { nested: "value" };
      const { evalContext } = applyBigIntConversion("__v0 === __v1", {
        __v0: obj,
      });
      expect(evalContext.__v0).toBe(obj);
    });

    it("should leave undefined unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 === undefined", {
        __v0: undefined,
      });
      expect(evalContext.__v0).toBeUndefined();
    });

    it("should leave mixed alphanumeric strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "31231231nfsdf",
      });
      expect(evalContext.__v0).toBe("31231231nfsdf");
    });

    it("should leave hex strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "0x1234567890abcdef",
      });
      expect(evalContext.__v0).toBe("0x1234567890abcdef");
    });

    it("should leave empty strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 === __v1", {
        __v0: "",
      });
      expect(evalContext.__v0).toBe("");
    });

    it("should leave negative number strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "-100",
      });
      expect(evalContext.__v0).toBe("-100");
    });

    it("should leave decimal strings unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: "3.14",
      });
      expect(evalContext.__v0).toBe("3.14");
    });

    it("should leave NaN unchanged", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: Number.NaN,
      });
      expect(evalContext.__v0).toBeNaN();
    });

    it("should leave Infinity unchanged (not an integer)", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: Number.POSITIVE_INFINITY,
      });
      expect(evalContext.__v0).toBe(Number.POSITIVE_INFINITY);
    });

    it("should leave arrays unchanged", () => {
      const arr = [1, 2, 3];
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: arr,
      });
      expect(evalContext.__v0).toBe(arr);
    });

    it("should convert zero string to BigInt(0)", () => {
      const { evalContext } = applyBigIntConversion("__v0 === __v1", {
        __v0: "0",
      });
      expect(evalContext.__v0).toBe(BigInt(0));
    });

    it("should handle negative integer numbers", () => {
      const { evalContext } = applyBigIntConversion("__v0 > 100", {
        __v0: -42,
      });
      expect(evalContext.__v0).toBe(BigInt(-42));
    });
  });

  describe("expression literal replacement", () => {
    it("should replace number literals with __b variables", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 > 1000000000000000000",
        { __v0: "2000000000000000000" }
      );
      expect(expression).toBe("__v0 > __b0");
      expect(evalContext.__b0).toBe(BigInt("1000000000000000000"));
    });

    it("should replace multiple literals with sequential __b variables", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 > 100 && __v0 < 999",
        { __v0: "500" }
      );
      expect(expression).toBe("__v0 > __b0 && __v0 < __b1");
      expect(evalContext.__b0).toBe(BigInt(100));
      expect(evalContext.__b1).toBe(BigInt(999));
    });

    it("should handle expression with no literals", () => {
      const { expression } = applyBigIntConversion("__v0 === __v1", {
        __v0: "100",
        __v1: "200",
      });
      expect(expression).toBe("__v0 === __v1");
    });

    it("should not replace digits inside double-quoted strings", () => {
      const { expression } = applyBigIntConversion(
        '__v0 === "2000000000000000000"',
        { __v0: "2000000000000000000" }
      );
      expect(expression).toBe('__v0 === "2000000000000000000"');
    });

    it("should not replace digits inside single-quoted strings", () => {
      const { expression } = applyBigIntConversion(
        "__v0 === '9007199254740993'",
        { __v0: "9007199254740993" }
      );
      expect(expression).toBe("__v0 === '9007199254740993'");
    });

    it("should replace bare literals but leave quoted ones intact", () => {
      const { expression, evalContext } = applyBigIntConversion(
        '__v0 > 100 && __v0 !== "200"',
        { __v0: "9007199254740993" }
      );
      expect(expression).toBe('__v0 > __b0 && __v0 !== "200"');
      expect(evalContext.__b0).toBe(BigInt(100));
    });
  });

  describe("decimal literal handling", () => {
    it("should preserve decimal literals instead of splitting them", () => {
      const { expression } = applyBigIntConversion("__v0 > 3.14", {
        __v0: "9007199254740993",
      });
      expect(expression).toBe("__v0 > 3.14");
    });

    it("should replace integer literals but leave decimals in same expression", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 > 100 && __v1 > 3.14",
        { __v0: "9007199254740993", __v1: 5.0 }
      );
      expect(expression).toBe("__v0 > __b0 && __v1 > 3.14");
      expect(evalContext.__b0).toBe(BigInt(100));
    });
  });

  describe("full conversion scenarios", () => {
    it("should produce correct BigInt comparison for wei balance check", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 > 1000000000000000000",
        { __v0: "2000000000000000000" }
      );

      expect(expression).toBe("__v0 > __b0");
      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));
      expect(evalContext.__b0).toBe(BigInt("1000000000000000000"));

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });

    it("should preserve precision for off-by-one comparisons", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 === 9007199254740993",
        { __v0: "9007199254740993" }
      );

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });

    it("should correctly fail off-by-one inequality", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 === 9007199254740993",
        { __v0: "9007199254740992" }
      );

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(false);
    });
  });

  describe("mixed BigInt and string operator scenarios", () => {
    it("should handle String().includes() alongside BigInt comparison", () => {
      // Simulates: String(balance).includes("000") && balance > 1e18
      // When BigInt mode triggers, balance becomes BigInt but String(BigInt)
      // still returns a digit string, so includes() works correctly.
      const { expression, evalContext } = applyBigIntConversion(
        'String(__v0).includes("000") && __v0 > 1000000000000000000',
        { __v0: "2000000000000000000" }
      );

      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });

    it("should handle String().startsWith() with BigInt context value", () => {
      const { expression, evalContext } = applyBigIntConversion(
        'String(__v0).startsWith("200") && __v0 > 100',
        { __v0: "2000000000000000000" }
      );

      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });

    it("should handle non-numeric string alongside BigInt comparison", () => {
      // One variable is a large number (triggers BigInt mode), another is
      // a non-numeric string that stays as-is during conversion.
      const { expression, evalContext } = applyBigIntConversion(
        '__v0 > 1000000000000000000 && __v1 === "active"',
        { __v0: "2000000000000000000", __v1: "active" }
      );

      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));
      expect(evalContext.__v1).toBe("active");

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });

    it("should handle boolean alongside BigInt comparison", () => {
      const { expression, evalContext } = applyBigIntConversion(
        "__v0 > 1000000000000000000 && __v1 === true",
        { __v0: "2000000000000000000", __v1: true }
      );

      expect(evalContext.__v0).toBe(BigInt("2000000000000000000"));
      expect(evalContext.__v1).toBe(true);

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);
      const fn = new Function(...varNames, `return (${expression});`);
      expect(fn(...varValues)).toBe(true);
    });
  });
});
