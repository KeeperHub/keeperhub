import { describe, expect, it, vi } from "vitest";

// The executor is server-only, and the end-to-end case below drives it directly.
vi.mock("server-only", () => ({}));

import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  expressionToConditionGroup,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";
import { regexPatternProblem } from "@/lib/workflow/nodes/condition/regex-pattern";
import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import {
  preValidateConditionExpression,
  validateConditionExpression,
  validateConditionExpressionUI,
} from "@/lib/workflow/nodes/condition/validator";

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
    // On the substituted expression, which is what the executor validates: the
    // template token is not part of what reaches the condition.
    expect(validateConditionExpression(resolve(expression))).toEqual({
      valid: true,
    });
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
    // A group whose body trails an unbounded atom, with nothing overlapping
    // after it: the rule refuses the split, not the group. These are the cases
    // that stop the edge propagation from tightening into uselessness.
    ["a lone group trailing an unbounded atom", "(a*)$"],
    ["two such groups over disjoint sets", "(a*)(b*)$"],
    ["an unbounded group preceded by a disjoint atom", "[0-9]+(a*)$"],
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
    // The split does not have to be between two atoms at the top level. An
    // unquantified group carries its body's ambiguity across the `)`, and an
    // atom whose quantifier permits zero occurrences does not separate the atoms
    // around it because it can vanish. Measured here with
    // `new RegExp(src).test("a".repeat(25) + "!")`: eight `(a*)` groups return
    // after 1.90 s and ten after 25.25 s, about 3.3x per added group, and the
    // 512 character pattern cap admits roughly 127 of them.
    ["an unquantified group trailing an unbounded atom", "(a+)a+$"],
    ["a group whose body leads with an unbounded atom", "a+(a+)$"],
    ["the same shape written non-capturing", "(?:a+)a+$"],
    ["an optional atom between two overlapping quantified atoms", "a+b?a+$"],
    ["two unquantified groups, each trailing an unbounded atom", "(a*)(a*)$"],
    ["three of them", "(a*)(a*)(a*)$"],
    [
      "eight of them, 25.25 s when the pattern is allowed to run",
      `${"(a*)".repeat(8)}$`,
    ],
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

  it("refuses the group-edge shapes through the executor, not only the builder", () => {
    // The reviewer measured `safeEvaluateCondition` with six `(a*)` groups
    // returning `true` rather than throwing, which is the whole reason the
    // group's edges have to be propagated: the atom-level rule saw one atom.
    // Driving `evaluateConditionExpression` is the path a stored condition
    // actually takes, pre-validation through substitution through validation
    // through evaluation.
    const outputs = {
      node1: {
        label: "Webhook",
        data: { error: `${"a".repeat(25)}!` },
      },
    } as never;

    for (const pattern of [
      "(a*)(a*)(a*)(a*)(a*)(a*)$",
      "(a+)a+$",
      "a+(a+)$",
      "a+b?a+$",
    ]) {
      expect(() =>
        evaluateConditionExpression(
          `matchesRegex(String({{@node1:Webhook.error}}), ${JSON.stringify(pattern)})`,
          outputs
        )
      ).toThrow(/split between them/);
    }

    // And the same path still runs the pattern the product recommends, so the
    // refusal above is the split and not the surrounding machinery.
    const outputs2 = {
      node1: {
        label: "Webhook",
        data: {
          error: "Contract call failed: Error(Splitter/kicked-too-soon)",
        },
      },
    } as never;
    expect(
      evaluateConditionExpression(
        'matchesRegex(String({{@node1:Webhook.error}}), "Error\\\\(")',
        outputs2
      ).result
    ).toBe(true);
  });
});

/**
 * Literal content is a config value, not syntax. Four scanners used to read the
 * raw text with the pattern literal still in it, so a pattern the docs and the
 * runtime error messages recommend was refused by the condition the reviewer of
 * the builder would save: `Error\(` came back as "Unbalanced parentheses", and
 * `^process-\d+$` tripped the pre-substitution keyword list.
 */
describe("matchesRegex literal syntax is not read as code", () => {
  const admitted = (expression: string) =>
    expect(validateConditionExpression(expression)).toEqual({ valid: true });

  it("admits the Escape-in-a-pattern the Write Contract error message recommends", () => {
    admitted('matchesRegex(__v0, "Error\\\\(")');
  });

  it("admits a pattern whose text looks like a method call", () => {
    admitted('matchesRegex(__v0, "x.toFixed()")');
  });

  it("admits a pattern whose text carries a disallowed keyword", () => {
    admitted('matchesRegex(__v0, "^process-\\d+$")');
    admitted('matchesRegex(__v0, "^document-\\d+$")');
  });

  it("still refuses those shapes when they are code rather than a literal", () => {
    // The negative control for the masking above: a scanner that reads the
    // masked copy has to keep refusing what the mask is not covering.
    expect(validateConditionExpression("__v0 === (1").valid).toBe(false);
    expect(validateConditionExpression("__v0.toFixed()").valid).toBe(false);
    expect(validateConditionExpression("process.exit(1) === __v0").valid).toBe(
      false
    );
    expect(validateConditionExpression("[1,2,3] === __v0").valid).toBe(false);
  });

  it("keeps the pre-substitution check off literal content too", () => {
    // This runs before template substitution, so the expression still carries
    // `{{@...}}` tokens: the mask has to leave those alone and only rewrite what
    // sits between quotes.
    expect(
      preValidateConditionExpression(
        'matchesRegex({{@trigger-1:Webhook.error}}, "^process-\\d+$")'
      )
    ).toEqual({ valid: true });
    expect(
      preValidateConditionExpression("process.env.SECRET === __v0").valid
    ).toBe(false);
  });

  it("refuses a third argument rather than silently dropping the flag", () => {
    expect(() =>
      safeEvaluateCondition('matchesRegex(__v0, "a", "i")', { __v0: "A" })
    ).toThrow(/exactly two arguments/);
  });

  it("runs end to end through the executor's own entry point", () => {
    // preValidate, substitution, validate and evaluate in the order the executor
    // runs them, which nothing else in the suite does for this operator.
    const outputs = {
      node1: {
        label: "Webhook",
        data: {
          error:
            "Contract call failed: Error(Splitter/kicked-too-soon) - the recipient was already removed",
        },
      },
    };
    const matched = evaluateConditionExpression(
      'matchesRegex(String({{@node1:Webhook.error}}), "Error\\\\(")',
      outputs
    );
    expect(matched.result).toBe(true);

    const notMatched = evaluateConditionExpression(
      'matchesRegex(String({{@node1:Webhook.error}}), "^0x[0-9a-fA-F]{40}$")',
      outputs
    );
    expect(notMatched.result).toBe(false);
  });
});

/**
 * The four mechanical items from the round-5 review, each of which reaches a user
 * differently: a mask that turned a string's text into a call, an arity error
 * reported as a bad pattern, a pattern that validated clean and threw inside the
 * executor, and a separator token accepted anywhere.
 */
describe("matchesRegex call parsing", () => {
  it("does not read a call that is text inside a string literal", () => {
    // The three-argument shape inside an unrelated literal used to be parsed as a
    // call, so a `contains` rule against that text was refused.
    for (const validate of [
      validateConditionExpression,
      validateConditionExpressionUI,
    ]) {
      expect(validate('String(__v0).includes("matchesRegex(a, b)")')).toEqual({
        valid: true,
      });
    }
  });

  it("refuses a call that does not have both arguments", () => {
    // Skipped before, which left the call valid while the evaluator read the
    // missing pattern as the string "undefined": `matchesRegex()` matched any
    // value at all and `matchesRegex(String(__v0))` matched any value containing
    // "undefined", which is what an unresolved node output stringifies to.
    for (const expr of ["matchesRegex()", "matchesRegex(String(__v0))"]) {
      const result = validateConditionExpression(expr);
      expect(result.valid, expr).toBe(false);
      if (!result.valid) {
        expect(result.error, expr).toContain("exactly two arguments");
      }
    }
  });

  it("reports a third argument as an arity error, not as a bad pattern", () => {
    const result = validateConditionExpression('matchesRegex(__v0, "a", "i")');
    if (result.valid) {
      throw new Error("expected a refusal");
    }
    expect(result.error).toContain("exactly two arguments");
    // The operand used to be read as everything after the first comma, so the
    // message named `"a", "i"` as a pattern that is not a quoted literal.
    expect(result.error).not.toContain("quoted pattern");
  });

  it("refuses a pattern the engine cannot compile, before the run", () => {
    // Requiring a literal is only worth it if the pattern can be built first:
    // this validated clean and threw `Unterminated group` inside the executor.
    for (const pattern of ["(", "[", "a{2,1}", "*x"]) {
      const result = validateConditionExpression(
        `matchesRegex(__v0, ${JSON.stringify(pattern)})`
      );
      if (result.valid) {
        throw new Error(`expected ${pattern} to be refused`);
      }
      expect(result.error).toContain("not a valid regular expression");
    }
  });

  it("still admits a pattern the engine compiles", () => {
    expect(
      validateConditionExpression('matchesRegex(__v0, "^0x[0-9a-fA-F]{40}$")')
    ).toEqual({ valid: true });
  });

  it("refuses a separator token outside a call", () => {
    // The token exists for `matchesRegex(a, b)`. Accepted anywhere it loosened
    // the editor into accepting `{{@a:B.f}} === 1, 2`, which staging refuses.
    const result = validateConditionExpressionUI("{{@a:B.f}} === 1, 2");
    if (result.valid) {
      throw new Error("expected a refusal");
    }
    expect(result.error).toContain("Invalid character");
  });

  it("still admits a comma inside a literal", () => {
    expect(
      validateConditionExpressionUI('String(__v0).includes("a, b")')
    ).toEqual({ valid: true });
  });

  it("validates the substituted expression, as the executor does", () => {
    // The call sites in `scanned` are the masked copy, so the operands are sliced
    // from the original at the same offsets. A length-preserving mask is what
    // makes that safe, and this pins the property rather than the mechanism.
    expect(
      validateConditionExpression(
        'matchesRegex(String({{@n:N.thing}}), "^[a-c]+$")'
      )
    ).toEqual({ valid: true });
  });
});

describe("the guard's own cost", () => {
  // The two families the round-10 review measured, both admitted before these
  // bounds existed, because the guard recurses through the nesting it examines:
  // `atomAt` on a group calls `groupSet` and `groupBodyEdges` over the body, and
  // `hasAdjacentQuantifiedAtoms` walks it a third time.
  const nested = (depth: number) =>
    `^${"(".repeat(depth)}a${")".repeat(depth)}$`;
  const alternated = (n: number) => `^(?:a|a)${"(?:a|a)".repeat(n)}$`;

  it("refuses nesting deeper than the bound, and quickly", () => {
    for (const depth of [16, 24, 40]) {
      const started = performance.now();
      const problem = regexPatternProblem(nested(depth));
      const elapsed = performance.now() - started;
      expect(problem, `depth ${depth}`).not.toBeNull();
      // 4.9 seconds at depth 24 before the bound. The refusal has to be cheap
      // enough that it is not itself the stall, which is the whole finding.
      expect(elapsed, `depth ${depth}`).toBeLessThan(50);
    }
  });

  it("refuses more groups than the bound", () => {
    // 2^n in the group count, needing neither a nested quantifier nor two
    // adjacent atoms: 26 groups was 2.3 seconds and the character cap admitted
    // around 73 of them.
    expect(regexPatternProblem(alternated(26))).not.toBeNull();
  });

  it("admits the shapes it is for, within a budget", () => {
    // The case the review asked for. Nothing pinned that an admitted pattern
    // stays fast, which is how both families above shipped with the suite green.
    const admitted = [
      "^0x[0-9a-fA-F]{40}$",
      "^\\d+(\\.\\d+)?$",
      "^v\\d+\\.\\d+(\\.\\d+)?$",
      "^(0x)?[0-9a-fA-F]{40}$",
      "^(?:cat|dog)$",
      "^0x[a-f0-9]{64}$",
    ];
    const started = performance.now();
    for (const pattern of admitted) {
      expect(regexPatternProblem(pattern), pattern).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("quantifiers that cannot repeat", () => {
  it("admits a group whose only quantifier is optional", () => {
    // `?` matches at most once and cannot backtrack. Reading it as a quantifier
    // refused `^\d+(\.\d+)?$` and `^v\d+\.\d+(\.\d+)?$`, which are the first
    // two patterns an author reaches for, and `(0x)?` beside them.
    for (const pattern of [
      "^\\d+(\\.\\d+)?$",
      "^v\\d+\\.\\d+(\\.\\d+)?$",
      "^(0x)?[0-9a-fA-F]{40}$",
    ]) {
      expect(regexPatternProblem(pattern), pattern).toBeNull();
    }
  });

  it("still refuses one that can", () => {
    for (const pattern of [
      "^(a+)+$",
      "^(a*)*$",
      "^(?:a|b)+$",
      // A slug is the ordinary shape this rule is for rather than an edge: the
      // inner `[a-z]+` inside a `*` group can be split with the hyphens, so it is
      // refused, and it was refused before this round too.
      "^[a-z]+(?:-[a-z]+)*$",
    ]) {
      expect(regexPatternProblem(pattern), pattern).not.toBeNull();
    }
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
