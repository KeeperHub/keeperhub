// Security hardening for matches regex and the condition path around it: each
// case is an attack an audit of this feature tried.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyBigIntConversion } from "@/lib/bigint-condition-utils";
import { generateWorkflowSDKCode } from "@/lib/workflow/codegen/sdk";
import { evaluateConditionExpression } from "@/lib/workflow/executor/executor.workflow";
import { editorConditionState } from "@/lib/workflow/nodes/condition/builder-utils";
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
        "reached this node's matching limit"
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

    it("charges a compile the same whether or not it is cached", () => {
      const pattern = `^${"q".repeat(400)}`;
      // Warm the cache, then charge a cached compile: 400 x 2,000 for the
      // length plus the compiled steps x 400.
      compileRegex(pattern, false);
      const budget = new RegexBudget(1_000_000);
      expect(() => compileRegex(pattern, false, budget)).not.toThrow();
      expect(() => compileRegex(pattern, false, budget)).toThrow(
        RegexBudgetError
      );
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
    it("refuses a condition over 10,000 characters in every check", () => {
      const long = `${FIELD} === "${"a".repeat(10_000)}"`;
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
      expect(code).toContain("not supported in exported code");
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
  });
});
