import { describe, expect, it } from "vitest";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  expressionToConditionGroup,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";
import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import { validateConditionExpression } from "@/lib/workflow/nodes/condition/validator";

/**
 * Regression coverage for #2407: `matchesRegex` used to compile to
 * `new RegExp(pattern).test(String(value))`, which the validator rejects (`new`
 * is in DANGEROUS_PATTERNS) and the interpreter cannot run (`test` is not an
 * allowed method, and there is no `new`). The operator was therefore reachable
 * from the builder and dead at both ends.
 *
 * These cases assert the operator now evaluates, not merely that it compiles.
 */
const ADDRESS = "0x1111111111111111111111111111111111111111";
const NOT_AN_ADDRESS = "0xnothex";

const ADDRESS_GROUP = {
  logic: "AND",
  rules: [
    {
      leftOperand: "{{@trigger-1:Webhook.safeAddress}}",
      operator: "matchesRegex",
      rightOperand: "^0x[0-9a-fA-F]{40}$",
    },
  ],
} as unknown as ConditionGroup;

/** Substitute the template the way the executor does before evaluating. */
function resolve(expression: string): string {
  return expression.replace(/\{\{@trigger-1:Webhook\.safeAddress\}\}/g, "__v0");
}

describe("matchesRegex compiles to a form the pipeline accepts", () => {
  const expression = visualConditionToExpression(ADDRESS_GROUP);

  it("does not emit the constructs that made it unreachable", () => {
    expect(expression).not.toContain("new RegExp");
    expect(expression).not.toContain(".test(");
    expect(expression).toBe(
      'matchesRegex(String({{@trigger-1:Webhook.safeAddress}}), "^0x[0-9a-fA-F]{40}$")'
    );
  });

  it("passes the runtime validator", () => {
    expect(validateConditionExpression(expression)).toEqual({ valid: true });
  });

  // The UI validator is deliberately not asserted here. Its spacing scan reads
  // the raw text, so the `-` inside `[0-9a-fA-F]` is checked as arithmetic and
  // the expression is refused in the editor. That is a separate fix, split out
  // of this issue with credit to the reporter, and pinning either behaviour here
  // would break whichever of the two lands second.

  it("passes the interpreter's static allowlist once resolved", () => {
    expect(isSafeConditionExpression(resolve(expression))).toBe(true);
  });
});

describe("matchesRegex evaluates", () => {
  const resolved = resolve(visualConditionToExpression(ADDRESS_GROUP));

  it("matches a value that fits the pattern", () => {
    expect(safeEvaluateCondition(resolved, { __v0: ADDRESS })).toBe(true);
  });

  it("does not match a value that does not fit", () => {
    expect(safeEvaluateCondition(resolved, { __v0: NOT_AN_ADDRESS })).toBe(
      false
    );
  });

  it("a character class is evaluated as a pattern, not as indexing", () => {
    // The [0-9a-fA-F] range is what the bracket scan used to read as
    // `f[0-9a-fA-F]` indexing and reject with "Cannot index".
    expect(safeEvaluateCondition('matchesRegex("abc", "^[a-c]+$")', {})).toBe(
      true
    );
    expect(safeEvaluateCondition('matchesRegex("xyz", "^[a-c]+$")', {})).toBe(
      false
    );
  });

  it("a pattern whose text contains a hyphen is not read as subtraction", () => {
    expect(
      safeEvaluateCondition(
        'matchesRegex("555-1234", "^\\\\d{3}-\\\\d{4}$")',
        {}
      )
    ).toBe(true);
  });
});

describe("matchesRegex did not widen what the pipeline accepts", () => {
  it("still refuses `new`", () => {
    expect(validateConditionExpression('new RegExp("x").test("y")').valid).toBe(
      false
    );
    expect(isSafeConditionExpression('new RegExp("x")')).toBe(false);
    expect(() => safeEvaluateCondition('new RegExp("x")', {})).toThrow();
  });

  it("still refuses `eval`", () => {
    expect(validateConditionExpression('eval("1+1") === 2').valid).toBe(false);
  });

  it("still refuses the `.test` method", () => {
    expect(validateConditionExpression('__v0.test("x")').valid).toBe(false);
    expect(() =>
      safeEvaluateCondition('__v0.test("x")', { __v0: "x" })
    ).toThrow();
  });

  it("still refuses a function name that is not allowlisted", () => {
    expect(() => safeEvaluateCondition('notAllowed("x")', {})).toThrow(
      /not allowed/
    );
  });

  it("still allows a quoted bracket key", () => {
    expect(validateConditionExpression('__v0["key"] === "a"')).toEqual({
      valid: true,
    });
  });

  it("still refuses an array literal", () => {
    expect(validateConditionExpression("__v0 === [1,2,3]").valid).toBe(false);
  });

  it("bounds the pattern length rather than handing the executor a ReDoS", () => {
    const longPattern = "a".repeat(600);
    expect(() =>
      safeEvaluateCondition(`matchesRegex("x", "${longPattern}")`, {})
    ).toThrow(/longer than/);
  });

  it("propagates an invalid pattern as an error rather than a false match", () => {
    expect(() => safeEvaluateCondition('matchesRegex("x", "[")', {})).toThrow();
  });
});

describe("matchesRegex round-trips through the visual builder", () => {
  it("parses the form the builder now emits", () => {
    const parsed = expressionToConditionGroup(
      'matchesRegex(String({{@trigger-1:Webhook.safeAddress}}), "^0x[0-9a-fA-F]{40}$")'
    );
    const rule = parsed?.rules[0] as
      | { operator?: string; leftOperand?: string; rightOperand?: string }
      | undefined;
    expect(rule?.operator).toBe("matchesRegex");
    expect(rule?.rightOperand).toBe("^0x[0-9a-fA-F]{40}$");
  });

  it("still parses the form saved workflows hold", () => {
    // Conditions stored before this change contain `new RegExp(...).test(...)`,
    // so the parser has to keep reading it or those nodes stop reopening.
    const parsed = expressionToConditionGroup(
      'new RegExp("^[a-z]+@").test(String({{@trigger-1:Webhook.safeAddress}}))'
    );
    const rule = parsed?.rules[0] as { operator?: string } | undefined;
    expect(rule?.operator).toBe("matchesRegex");
  });
});

describe("matchesRegex pattern rule", () => {
  const admit = (pattern: string) =>
    validateConditionExpression(
      `matchesRegex(__v0, ${JSON.stringify(pattern)})`
    );
  // Narrowed in one place so each case reads as the assertion it is.
  const rejects = (pattern: string): string => {
    const result = admit(pattern);
    if (result.valid) {
      throw new Error(`expected ${pattern} to be refused`);
    }
    return result.error;
  };

  // Every shape the rule admits, pinned. The rule is written to be conservative
  // rather than to prove anything about a pattern, so the admitted set is what
  // stops it from being tightened into uselessness by accident.
  it.each([
    ["a checksummed address", "^0x[0-9a-fA-F]{40}$"],
    ["a bounded character class", "^[a-c]+$"],
    ["an unquantified alternation", "^(foo|bar)$"],
    ["a quantified plain group", "(foo)+"],
    ["a bounded repetition", "^\\d{1,4}$"],
    ["an anchored literal", "^transfer$"],
    // The group-type prefix is syntax, not body. Reading the `?` in `(?:` as a
    // quantifier refused every quantified non-capturing group, which is how
    // someone writes a condition against an address or a hash.
    ["a quantified non-capturing group", "(?:ab)+"],
    ["a repeated non-capturing group", "(?:abc)*"],
    ["an optional non-capturing prefix before a class", "(?:0x)?[0-9a-f]+"],
    ["an anchored quantified non-capturing group", "^(?:foo)+$"],
    ["a quantified named group", "(?<word>ab)+"],
    ["a quantified group holding a lookahead", "((?=a)b)+"],
    ["a quantified group wrapping a non-capturing group", "((?:ab))?"],
    // Adjacent quantified atoms whose sets do not overlap: each character
    // belongs to exactly one atom, so there is nothing to split. Tightening the
    // rule below into refusing these would break ordinary patterns.
    ["two adjacent atoms over disjoint sets", "[a-z]+[0-9]+"],
    ["a date of fixed repetitions", "\\d{4}-\\d{2}-\\d{2}"],
    ["an email shape with literal separators", "\\w+@\\w+\\.\\w+"],
    ["a scheme with one optional letter", "^https?://[^\\s]+$"],
    ["two quantified groups over disjoint sets", "(?:ab)+(?:cd)+"],
    ["two optional atoms, which match one way", "a?a?"],
  ])("admits %s", (_label, pattern) => {
    expect(admit(pattern as string)).toEqual({ valid: true });
  });

  // Every shape it refuses, and why the length cap does not cover them: `(a+)+$`
  // is seven characters. Conditions run in the executor with no timeout, so an
  // unbounded match stalls the run.
  it.each([
    ["a quantified group holding a quantifier", "(a+)+$"],
    ["a quantified class repetition", "([a-z]+)*"],
    ["a quantified alternation", "(a|b)+$"],
    ["a quantified non-capturing group", "(?:\\d+)+"],
    ["a nested quantifier behind an anchor", "^(a*)*$"],
    ["a quantified alternation of different lengths", "(a|aa)+$"],
    ["a quantified class repetition followed by a literal", "(\\d+)*x"],
    ["a quantified bounded repetition", "(a{2,})+"],
    ["an anchored quantified whitespace group", "^(\\s*\\w+)+$"],
  ])("refuses %s", (_label, pattern) => {
    expect(rejects(pattern as string)).toContain("backtrack");
  });

  it("refuses a pattern that is not a quoted literal", () => {
    // The pattern can arrive from a webhook through an operand, and nothing can
    // be checked about it before it gets here.
    const result = validateConditionExpression("matchesRegex(__v0, __v1)");
    if (result.valid) {
      throw new Error("expected a refusal");
    }
    expect(result.error).toContain("quoted pattern");
  });

  it("refuses a pattern over the length cap at validation time", () => {
    expect(rejects("a".repeat(513))).toContain("longer than");
  });

  it("leaves an expression with no regex call alone", () => {
    expect(validateConditionExpression('__v0 === "a"')).toEqual({
      valid: true,
    });
  });
});

/**
 * The two shapes the group rule cannot see, both driven end to end by the
 * reviewer: no parentheses at all, and a pattern whose quantifier arrives
 * through an escape the guard never decoded.
 */
describe("matchesRegex adjacent quantifier rule", () => {
  const admit = (pattern: string) =>
    validateConditionExpression(
      `matchesRegex(__v0, ${JSON.stringify(pattern)})`
    );
  const rejects = (pattern: string): string => {
    const result = admit(pattern);
    if (result.valid) {
      throw new Error(`expected ${pattern} to be refused`);
    }
    return result.error;
  };

  // Measured against the caps this operator enforces, with
  // `new RegExp(src).test("a".repeat(4096) + "!")`: the two term case returns
  // after 34.8 s, and sixteen terms stall 55 s on a 37 character input. The
  // group rule never examined either one, because no group is involved.
  it.each([
    ["two adjacent unbounded atoms, 34.8 s at the value cap", "a+a+$"],
    ["twelve adjacent atoms", `${"a+".repeat(12)}$`],
    [
      "sixteen adjacent atoms, 55 s on a 37 character input",
      `${"a+".repeat(16)}$`,
    ],
    ["a lazily quantified pair", "a+?a+"],
    ["a bounded repetition followed by an unbounded one", "a{2,}a+"],
    ["overlapping shorthands", "\\w+\\d+$"],
    ["a dot repetition followed by whitespace", ".*\\s+$"],
    ["the same shape inside an unquantified group", "(a+a+)"],
  ])("refuses %s", (_label, pattern) => {
    expect(rejects(pattern as string)).toContain("split between them");
  });

  /**
   * The guard scanned the raw literal while the evaluator decoded `\xNN` and
   * `\uNNNN` before compiling, so these carried no `+` for the scanner to find.
   * Written as raw expression text on purpose: the escape has to reach the
   * condition with a single backslash, which is what the reviewer measured
   * (`"(a\x2b)\x2b$"` compiles to `(a+)+$` and returns after 40.5 s on a 30
   * character input, `"^(a\u002a)\u002a$"` to `^(a*)*$`). Through
   * `JSON.stringify` the escape would arrive doubled and the pattern would be a
   * harmless literal instead.
   */
  const admitRaw = (patternText: string) =>
    validateConditionExpression(`matchesRegex(__v0, "${patternText}")`);
  const rejectsRaw = (patternText: string): string => {
    const result = admitRaw(patternText);
    if (result.valid) {
      throw new Error(`expected ${patternText} to be refused`);
    }
    return result.error;
  };

  it.each([
    ["an escaped quantifier in a group", "(a\\x2b)\\x2b$"],
    ["an escaped star in a group", "^(a\\u002a)\\u002a$"],
  ])("scans the decoded pattern, so it refuses %s", (_label, patternText) => {
    expect(rejectsRaw(patternText as string)).toContain("backtrack");
  });

  it("refuses an escaped quantifier with no group either", () => {
    // Decodes to `a+a+$`, so it is the adjacency rule that fires, not the group
    // rule. Before the guard decoded the literal it saw no `+` at all.
    expect(rejectsRaw("a\\x2ba+$")).toContain("split between them");
  });

  it("still admits the decoded form of a harmless escape", () => {
    // `\x2e` decodes to a dot, and an unquantified atom between the two
    // quantified ones breaks the adjacency. The split is bounded by the single
    // character the dot consumes, so this is not the shape being refused.
    expect(admit("\\w+\\x2e\\w+")).toEqual({ valid: true });
  });

  it("refuses at evaluation time too, not only at validation time", () => {
    // Stored conditions reach the executor without passing the builder, and the
    // length caps do not stop `(a+)+$`, so matchesRegex applies the same rule.
    const noisyValue = `${"a".repeat(30)}!`;
    expect(() =>
      safeEvaluateCondition('matchesRegex(__v0, "(a+)+$")', {
        __v0: noisyValue,
      })
    ).toThrow(/backtrack/);
    const adjacent = `${"a+".repeat(12)}$`;
    expect(() =>
      safeEvaluateCondition(`matchesRegex(__v0, "${adjacent}")`, {
        __v0: noisyValue,
      })
    ).toThrow(/split between them/);
  });
});

describe("matchesRegex value bound", () => {
  it("matches a value at the cap", () => {
    expect(
      safeEvaluateCondition('matchesRegex(__v0, "^a")', {
        __v0: "a".repeat(4096),
      })
    ).toBe(true);
  });

  it("refuses a value over the cap rather than matching it", () => {
    expect(() =>
      safeEvaluateCondition('matchesRegex(__v0, "^a")', {
        __v0: "a".repeat(4097),
      })
    ).toThrow(/value is longer than/);
  });
});
