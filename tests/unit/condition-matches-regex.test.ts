// matchesRegex end to end: what the builder emits must evaluate through the
// executor's own path (template resolution, the keyword pre-check, the
// validator, the large-integer rewrite, the interpreter). Asserting only the
// compiled string is how the operator stayed broken with no failing test (#2407).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyBigIntConversion } from "@/lib/bigint-condition-utils";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import { expressionToConditionGroup } from "@/lib/workflow/nodes/condition/builder-utils";
import { visualConditionToExpression } from "@/lib/workflow/nodes/condition/expression";
import { makeMissingReference } from "@/lib/workflow/nodes/condition/missing-reference";
import {
  MAX_REGEX_TEXT_LENGTH,
  REGEX_BACKSLASH_ERROR,
  REGEX_SOURCE_ERROR,
  regexPatternError,
} from "@/lib/workflow/nodes/condition/regex-match";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";
import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import { maskStringLiterals } from "@/lib/workflow/nodes/condition/string-literal";
import {
  validateConditionExpression,
  validateConditionExpressionUI,
} from "@/lib/workflow/nodes/condition/validator";

const ADDRESS = "0x9759A6Ac90977b93B58547b4A71c78317f391A28";
const FIELD = "{{@n1:Webhook.value}}";

function group(...rules: [string, string, string][]): ConditionGroup {
  return {
    id: "g",
    logic: "AND",
    rules: rules.map(([left, operator, right], index) => ({
      id: `r${index}`,
      leftOperand: left,
      operator: operator as "matchesRegex",
      rightOperand: right,
    })),
  };
}

// The executor's path for a typed or built condition, with Webhook.value set.
function run(expression: string, value: unknown): boolean {
  return evaluateConditionExpression(
    expression,
    { n1: { label: "Webhook", data: { value } } },
    new Map([["n1", {}]]),
    { n1: { success: true, data: { value } } }
  ).result;
}

// A visual rule as saved, resolved the way the executor resolves it.
function runRule(pattern: string, value: unknown): boolean {
  const expression = resolveConditionExpression({
    conditionConfig: { group: group([FIELD, "matchesRegex", pattern]) },
  });
  return run(expression ?? "", value);
}

describe("matchesRegex", () => {
  describe("a visual rule", () => {
    it("matches the address pattern from the issue", () => {
      expect(runRule("^0x[0-9a-fA-F]{40}$", ADDRESS)).toBe(true);
      expect(runRule("^0x[0-9a-fA-F]{40}$", "0x123")).toBe(false);
    });

    it("keeps backslash classes as typed", () => {
      expect(runRule("^\\d{3}-\\d{4}$", "555-1234")).toBe(true);
      expect(runRule("^\\d{3}-\\d{4}$", "555-12345")).toBe(false);
    });

    it("quotes a pattern that looks like a number, boolean or null", () => {
      expect(runRule("42", "x42y")).toBe(true);
      expect(runRule("1.5", "1x5")).toBe(true);
      expect(runRule("true", "untrue")).toBe(true);
      expect(runRule("null", "nullable")).toBe(true);
    });

    it("takes one layer of typed quotes off, keeping the rest as written", () => {
      expect(runRule('"\\d+"', "123")).toBe(true);
      expect(runRule('"a"|"b"', '"b"')).toBe(true);
    });

    it("refuses a pattern from another node", () => {
      expect(() => runRule("{{@n1:Webhook.value}}", "a")).toThrow(
        REGEX_SOURCE_ERROR
      );
    });

    it("reads words the keyword check looks for as data inside a pattern", () => {
      for (const [pattern, text] of [
        ["^Retrieval", "Retrieval done"],
        ["(?i)processed", "PROCESSED"],
        ["Import|Export", "Export"],
        ["globalFee", "globalFee"],
        ["^document-\\d+$", "document-7"],
        ["constructor", "constructor"],
      ]) {
        expect(runRule(pattern, text), pattern).toBe(true);
      }
    });

    it("passes patterns whose characters read as code to the old checks", () => {
      for (const [pattern, text] of [
        ["^(EMSP|MCD)_", "EMSP_HALT"],
        ["a=b", "xa=by"],
        ["^new Vault$", "new Vault"],
        ["^[a-z]+, [a-z]+$", "foo, bar"],
        ["^\\[(\\d+)\\]$", "[42]"],
        ["Error\\(", "Contract call failed: Error(x)"],
        ["^a && b || c$", "a && b || c"],
      ]) {
        expect(runRule(pattern, text), pattern).toBe(true);
      }
    });

    it("matches anywhere unless anchored, and ignores case with (?i)", () => {
      expect(runRule("EMSP", "SPELL_EMSP_X")).toBe(true);
      expect(runRule("^emsp_", "EMSP_X")).toBe(false);
      expect(runRule("(?i)^emsp_", "EMSP_X")).toBe(true);
    });

    it("tests numbers as their text, also in large-integer mode", () => {
      expect(runRule("^\\d+$", 1234)).toBe(true);
      expect(runRule("^\\d{30}$", "123456789012345678901234567890")).toBe(true);
    });
  });

  describe("reopening a saved condition", () => {
    it("keeps parentheses and && inside a pattern in their rule", () => {
      const expression = visualConditionToExpression(
        group([FIELD, "matchesRegex", "Error\\("], [FIELD, "contains", "z"])
      );
      const reopened = expressionToConditionGroup(expression);
      expect(
        reopened?.rules.map((rule) =>
          "operator" in rule
            ? [rule.leftOperand, rule.operator, rule.rightOperand]
            : "group"
        )
      ).toEqual([
        [FIELD, "matchesRegex", "Error\\("],
        [FIELD, "contains", "z"],
      ]);
    });

    it("reads the old new RegExp form, two rules included", () => {
      const reopened = expressionToConditionGroup(
        `new RegExp("^a\\\\)").test(String(${FIELD})) && String(${FIELD}).includes("z")`
      );
      expect(reopened?.rules).toHaveLength(2);
      expect(reopened?.rules[0]).toMatchObject({
        operator: "matchesRegex",
        rightOperand: "^a\\)",
      });
    });
  });

  describe("a typed expression", () => {
    it("runs with doubled backslashes", () => {
      expect(run(`matchesRegex(String(${FIELD}), "^\\\\d+$")`, "123")).toBe(
        true
      );
    });

    it("refuses a single backslash that JavaScript would drop", () => {
      for (const pattern of ["^\\d+$", "a\\.b", "\\bword"]) {
        const expression = `matchesRegex(String(${FIELD}), "${pattern}")`;
        expect(() => run(expression, "123"), pattern).toThrow(
          REGEX_BACKSLASH_ERROR
        );
        expect(validateConditionExpressionUI(expression), pattern).toEqual({
          valid: false,
          error: REGEX_BACKSLASH_ERROR,
        });
      }
    });

    it("can negate a match", () => {
      expect(run(`!matchesRegex(String(${FIELD}), "^a")`, "b")).toBe(true);
    });

    it("refuses a pattern that is not one quoted literal", () => {
      for (const expression of [
        `matchesRegex(String(${FIELD}), ${FIELD})`,
        `matchesRegex(String(${FIELD}), "a" + "b")`,
      ]) {
        expect(() => run(expression, "a")).toThrow(REGEX_SOURCE_ERROR);
        expect(validateConditionExpressionUI(expression)).toEqual({
          valid: false,
          error: REGEX_SOURCE_ERROR,
        });
      }
    });

    it("refuses the wrong number of values", () => {
      for (const expression of [
        "matchesRegex()",
        'matchesRegex("a")',
        'matchesRegex(String(__v0), "a", "b")',
      ]) {
        expect(() => safeEvaluateCondition(expression, { __v0: "a" })).toThrow(
          "takes two values"
        );
        expect(validateConditionExpressionUI(expression).valid).toBe(false);
      }
    });

    it("shows a bad pattern while typing, as the run would", () => {
      for (const [pattern, message] of [
        ["(?=a)", "Lookahead and lookbehind"],
        ["[a-", "Invalid regex pattern"],
        ["a".repeat(513), "the limit is 512"],
      ]) {
        expect(
          validateConditionExpressionUI(
            `matchesRegex(String(${FIELD}), "${pattern}")`
          )
        ).toEqual({ valid: false, error: expect.stringContaining(message) });
      }
      expect(
        validateConditionExpressionUI(
          `matchesRegex(String(${FIELD}), "^0x[0-9a-fA-F]{40}$")`
        )
      ).toEqual({ valid: true });
    });

    it("accepts a comma only between a call's values", () => {
      for (const expression of [`${FIELD} === 1, 2`, `(1, ${FIELD})`]) {
        expect(
          validateConditionExpressionUI(expression).valid,
          expression
        ).toBe(false);
      }
    });

    it("points regex objects at matchesRegex", () => {
      for (const expression of [
        `new RegExp("^0x").test(String(${FIELD}))`,
        `/^0x/.test(String(${FIELD}))`,
      ]) {
        expect(validateConditionExpressionUI(expression)).toEqual({
          valid: false,
          error: expect.stringContaining(
            'matchesRegex(String(value), "pattern")'
          ),
        });
        expect(() => run(expression, "0x1")).toThrow(
          "matchesRegex(String(value)"
        );
      }
    });
  });

  describe("pattern rules", () => {
    it("names what RE2 does not run and what to do instead", () => {
      expect(regexPatternError("^(?=EMSP)")).toContain("Use a second rule");
      expect(regexPatternError("(?<!x)a")).toContain(
        "Lookahead and lookbehind"
      );
      expect(regexPatternError("(a)\\1")).toContain("Back-references");
      expect(regexPatternError("\\u00e9")).toContain("\\x{00e9}");
      expect(regexPatternError("/^emsp_/i")).toContain("Leave out the /.../");
      expect(regexPatternError("[a-")).toContain("Invalid regex pattern");
      expect(regexPatternError("\\0")).toBeUndefined();
      expect(regexPatternError("^0x[0-9a-f]{40}$")).toBeUndefined();
      expect(regexPatternError("/api/v1/")).toBeUndefined();
    });

    it("refuses a pattern that compiles to too many steps", () => {
      expect(regexPatternError("(?:\\w?){1000}x")).toContain(
        "the limit is 1,000"
      );
      expect(regexPatternError("(?i)(?:\\w?){450}x")).toBeUndefined();
    });

    it("caps the text, with a step to take", () => {
      expect(() => runRule("a", "a".repeat(MAX_REGEX_TEXT_LENGTH + 1))).toThrow(
        "tests at most 4,096. Test a shorter field"
      );
      expect(runRule("a$", "a".repeat(MAX_REGEX_TEXT_LENGTH))).toBe(true);
    });

    it("runs the worst admitted patterns at the caps in bounded time", () => {
      const text = "a".repeat(MAX_REGEX_TEXT_LENGTH);
      for (const pattern of [
        "(?i)(?:\\w?){450}x",
        "(?:\\pL?){330}\\pN",
        "^(a+)+$",
        "^(a|a)*$",
      ]) {
        const started = performance.now();
        runRule(pattern, text);
        expect(performance.now() - started, pattern).toBeLessThan(1500);
      }
    });

    it("stops one Condition at its matching budget", () => {
      const call = `matchesRegex(String(${FIELD}), "(?i)(?:\\\\w?){450}x")`;
      const expression = Array.from({ length: 7 }, () => call).join(" || ");
      expect(() => run(expression, "a".repeat(MAX_REGEX_TEXT_LENGTH))).toThrow(
        "reached its limit for one run"
      );
      // The budget is per evaluation, not per process.
      expect(runRule("(?i)(?:\\w?){450}x", "x")).toBe(true);
    });

    it("refuses a list or object as the text", () => {
      expect(() =>
        safeEvaluateCondition('matchesRegex(__v0, "object")', { __v0: {} })
      ).toThrow("not a list or object");
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

  describe("string masking in the validators", () => {
    it("accepts ordinary text values the old checks misread as code", () => {
      for (const value of [
        "foo bar baz",
        "a=b",
        "new Vault",
        "eval(x)",
        "process",
      ]) {
        expect(run(`String(${FIELD}).includes("${value}")`, value), value).toBe(
          true
        );
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

    it("refuses an unterminated string before the large-integer rewrite", () => {
      const expression = `__v0 > 1 && __v1 == "${'\\"'.repeat(40_000)}`;
      const started = performance.now();
      expect(validateConditionExpression(expression)).toEqual({
        valid: false,
        error: expect.stringContaining("unterminated string"),
      });
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("blanks only string contents, with the interpreter's quote rules", () => {
      expect(maskStringLiterals("a(\"x y\") + 'q\\'r'")).toBe(
        "a(\"___\") + '____'"
      );
      expect(() => maskStringLiterals('__v0 === "open')).toThrow(
        "Unterminated"
      );
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

    it("checks the pattern when the expression is checked for export", () => {
      expect(
        isSafeConditionExpression('matchesRegex(String(__v0), "(?=a)")')
      ).toBe(false);
      expect(
        isSafeConditionExpression('matchesRegex(String(__v0), "^a$")')
      ).toBe(true);
    });
  });
});
