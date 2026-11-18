// matchesRegex end to end: what the builder emits must pass the run-time
// validator and evaluate. Asserting only the compiled string is how the
// operator stayed broken with no failing test (#2407).

import { describe, expect, it } from "vitest";
import { applyBigIntConversion } from "@/lib/bigint-condition-utils";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import { visualConditionToExpression } from "@/lib/workflow/nodes/condition/expression";
import { makeMissingReference } from "@/lib/workflow/nodes/condition/missing-reference";
import {
  MAX_REGEX_TEXT_LENGTH,
  regexPatternError,
} from "@/lib/workflow/nodes/condition/regex-match";
import {
  isSafeConditionExpression,
  maskStringLiterals,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import { validateConditionExpression } from "@/lib/workflow/nodes/condition/validator";

const ADDRESS = "0x9759A6Ac90977b93B58547b4A71c78317f391A28";

function regexRule(pattern: string): ConditionGroup {
  return {
    id: "g",
    logic: "AND",
    rules: [
      {
        id: "r",
        leftOperand: "{{@n1:Webhook.address}}",
        operator: "matchesRegex",
        rightOperand: pattern,
      },
    ],
  };
}

// The executor's order: replace templates with __vN, validate, evaluate.
function runBuilt(pattern: string, value: unknown): unknown {
  const built = visualConditionToExpression(regexRule(pattern));
  const transformed = built.replace("{{@n1:Webhook.address}}", "__v0");
  const validation = validateConditionExpression(transformed);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  return safeEvaluateCondition(transformed, { __v0: value });
}

describe("matchesRegex", () => {
  describe("from the visual builder", () => {
    it("matches the address pattern from the issue", () => {
      expect(runBuilt("^0x[0-9a-fA-F]{40}$", ADDRESS)).toBe(true);
      expect(runBuilt("^0x[0-9a-fA-F]{40}$", "0x123")).toBe(false);
    });

    it("keeps backslash classes intact through the quoting", () => {
      expect(runBuilt("^\\d{3}-\\d{4}$", "555-1234")).toBe(true);
      expect(runBuilt("^\\d{3}-\\d{4}$", "555-12345")).toBe(false);
    });

    it("passes patterns whose characters read as code to the old checks", () => {
      for (const [pattern, text] of [
        ["^(EMSP|MCD)_", "EMSP_HALT"],
        ["a=b", "xa=by"],
        ["^new Vault$", "new Vault"],
        ["^[a-z]+, [a-z]+$", "foo, bar"],
        ["^\\[(\\d+)\\]$", "[42]"],
        ["^a b c$", "a b c"],
      ]) {
        expect(runBuilt(pattern, text), pattern).toBe(true);
      }
    });

    it("matches anywhere unless anchored, and ignores case with (?i)", () => {
      expect(runBuilt("EMSP", "SPELL_EMSP_X")).toBe(true);
      expect(runBuilt("^emsp_", "EMSP_X")).toBe(false);
      expect(runBuilt("(?i)^emsp_", "EMSP_X")).toBe(true);
    });

    it("tests a number as its text", () => {
      expect(runBuilt("^\\d+$", 1234)).toBe(true);
    });
  });

  describe("pattern rules", () => {
    it("refuses a pattern that is not a quoted literal", () => {
      expect(() =>
        safeEvaluateCondition("matchesRegex(String(__v0), __v1)", {
          __v0: "a",
          __v1: "a",
        })
      ).toThrow("must be typed in quotes");
      expect(
        isSafeConditionExpression("matchesRegex(String(__v0), __v1)")
      ).toBe(false);
    });

    it("refuses the wrong number of arguments", () => {
      for (const expression of [
        "matchesRegex()",
        'matchesRegex("a")',
        'matchesRegex(String(__v0), "a", "b")',
      ]) {
        expect(() => safeEvaluateCondition(expression, { __v0: "a" })).toThrow(
          "takes two arguments"
        );
      }
    });

    it("names lookaround and back-references, which RE2 does not run", () => {
      expect(regexPatternError("^(?=EMSP)")).toContain(
        "Lookahead and lookbehind"
      );
      expect(regexPatternError("(?<!x)a")).toContain(
        "Lookahead and lookbehind"
      );
      expect(regexPatternError("(a)\\1")).toContain("Back-references");
      expect(regexPatternError("[a-")).toContain("Invalid regex pattern");
      expect(regexPatternError("^0x[0-9a-f]{40}$")).toBeUndefined();
    });

    it("refuses a bad pattern before any text is read", () => {
      expect(() =>
        safeEvaluateCondition('matchesRegex(String(__v0), "(?=a)")', {})
      ).toThrow("Lookahead");
      expect(
        isSafeConditionExpression('matchesRegex(String(__v0), "(?=a)")')
      ).toBe(false);
      expect(
        isSafeConditionExpression('matchesRegex(String(__v0), "^a$")')
      ).toBe(true);
    });

    it("caps the pattern and the text", () => {
      expect(regexPatternError("a".repeat(513))).toContain("the limit is 512");
      expect(() =>
        runBuilt("a", "a".repeat(MAX_REGEX_TEXT_LENGTH + 1))
      ).toThrow("at most 4096");
      expect(runBuilt("a$", "a".repeat(MAX_REGEX_TEXT_LENGTH))).toBe(true);
    });

    it("runs catastrophic-backtracking patterns in linear time", () => {
      const text = `${"a".repeat(MAX_REGEX_TEXT_LENGTH - 1)}!`;
      for (const pattern of [
        "^(a+)+$",
        "^(a|a)*$",
        "^(a*)*b$",
        "(\\w+\\s?)*$!",
      ]) {
        const started = performance.now();
        runBuilt(pattern, text);
        expect(performance.now() - started, pattern).toBeLessThan(500);
      }
    });
  });

  describe("missing fields", () => {
    const missing = makeMissingReference("address was not found.");

    it("reports a missing field instead of matching its placeholder text", () => {
      expect(() =>
        safeEvaluateCondition('matchesRegex(String(__v0), ".")', {
          __v0: missing,
        })
      ).toThrow("address was not found");
      expect(() =>
        safeEvaluateCondition('matchesRegex(__v0, ".")', { __v0: missing })
      ).toThrow("address was not found");
    });

    it("does the same for the other text operators through String()", () => {
      expect(() =>
        safeEvaluateCondition('String(__v0).includes("object")', {
          __v0: missing,
        })
      ).toThrow("address was not found");
    });
  });

  describe("the old new RegExp form", () => {
    it("names the replacement instead of the generic syntax error", () => {
      const result = validateConditionExpression(
        'new RegExp("^0x").test(String(__v0))'
      );
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining(
          'matchesRegex(String(value), "pattern")'
        ),
      });
    });
  });

  describe("string masking in the run-time validator", () => {
    it("accepts ordinary text values the old checks misread as code", () => {
      for (const expression of [
        'String(__v0).includes("foo bar baz")',
        'String(__v0).includes("a=b")',
        'String(__v0).includes("new Vault")',
        '__v0 === "eval(x)"',
        '__v0 === "process"',
      ]) {
        expect(validateConditionExpression(expression), expression).toEqual({
          valid: true,
        });
      }
    });

    it("still rejects code outside the quotes, including after an escaped quote", () => {
      for (const expression of [
        '__v0 === "x" || new Foo()',
        '__v0 === "\\"" || eval("1")',
        "__v0 === 'it\\'s' || process",
        '__v0 = "a"',
        '"a" + __v0[foo]',
      ]) {
        expect(validateConditionExpression(expression).valid, expression).toBe(
          false
        );
      }
    });

    it("blanks only string contents, with the interpreter's own quote rules", () => {
      expect(maskStringLiterals("a(\"x y\") + 'q\\'r'")).toBe(
        "a(\"___\") + '____'"
      );
      // Unterminated: left alone, and the interpreter rejects it anyway.
      expect(maskStringLiterals('__v0 === "open')).toBe('__v0 === "open');
    });
  });

  describe("large-integer mode", () => {
    it("leaves digits inside a quoted pattern alone, past an escaped quote", () => {
      const { expression } = applyBigIntConversion(
        'matchesRegex(String(__v0), "^\\"\\\\d{25}\\"$") && __v1 > 5',
        { __v0: '"1234567890123456789012345"', __v1: "99999999999999999999" }
      );
      expect(expression).toContain('"^\\"\\\\d{25}\\"$"');
      expect(expression).toContain("__v1 > __b0");
    });
  });

  describe("allowlist", () => {
    it("does not reach Object.prototype through a bare call", () => {
      for (const name of ["toString", "valueOf", "hasOwnProperty"]) {
        expect(() => safeEvaluateCondition(`${name}(1)`, {})).toThrow(
          "is not allowed"
        );
      }
    });
  });
});
