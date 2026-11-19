// Security hardening for matches regex and the condition path around it: each
// case is an attack an audit of this feature tried.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyBigIntConversion } from "@/lib/bigint-condition-utils";
import { generateWorkflowCode } from "@/lib/workflow/codegen/codegen";
import { generateWorkflowSDKCode } from "@/lib/workflow/codegen/sdk";
import { commentSafe } from "@/lib/workflow/codegen/shared";
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
    // Every condition: several checks scale worse than linearly.
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

    // The maintainer's case: about 95 address rules, 10,000 characters with
    // their references, about 5,000 once each is a short name.
    it("counts each reference as a short name, so a long allow-list fits", () => {
      const rule = (i: number): string =>
        `{{@node_${String(i).padStart(16, "0")}:Label.from}} === "0x${String(i).padStart(40, "0")}"`;
      const long = Array.from({ length: 120 }, (_, i) => rule(i)).join(" || ");
      expect(long.length).toBeGreaterThan(10_000);
      for (const result of [
        preValidateConditionExpression(long),
        validateConditionExpressionUI(long),
      ]) {
        expect(result).toEqual({ valid: true });
      }
      // As the run checks it, references already replaced.
      const resolved = Array.from(
        { length: 120 },
        (_, i) => `__v${i} === "0x${String(i).padStart(40, "0")}"`
      ).join(" || ");
      expect(validateConditionExpression(resolved)).toEqual({ valid: true });
    });

    it("shows the visual limits before a run", () => {
      const rules = Array.from(
        { length: 17 },
        () => `matchesRegex(${FIELD}, "a")`
      ).join(" || ");
      expect(visualConditionLimitError(rules)).toBe(
        "A Condition can have at most 16 regex rules. Split them across two Condition nodes"
      );
      expect(
        visualConditionLimitError(`${FIELD} === "${"a".repeat(10_000)}"`)
      ).toContain("Together the rules are");
      expect(visualConditionLimitError(`${FIELD} === "a"`)).toBeUndefined();
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
    it("refuses notMatchesRegex(...) as a function, before any run", () => {
      const condition = `notMatchesRegex(${FIELD}, "a")`;
      for (const result of [
        preValidateConditionExpression(condition),
        validateConditionExpressionUI(condition),
      ]) {
        expect(result).toEqual({
          valid: false,
          error: expect.stringContaining("Write !matchesRegex(...)"),
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

    // The maintainer's example: the path is kept as a quoted key, not code.
    it("writes any field path as a key, never as code", () => {
      const injected = `{{@n1:Webhook.a || fetch(atob("aHR0cDovL2V2aWw")) || b}} == 1`;
      expect(workflowCode(injected)).toContain(
        'if (webhookResult["a || fetch(atob(\\"aHR0cDovL2V2aWw\\")) || b"] == 1) {'
      );
      expect(exported(injected)).toContain(
        `?.data?.["a || fetch(atob(\\"aHR0cDovL2V2aWw\\")) || b"]} == 1`
      );
      expect(workflowCode("{{@n1:Webhook.items[0][1].value}} == 1")).toContain(
        "if (webhookResult.items[0][1].value == 1) {"
      );
      expect(workflowCode("{{@n1:Webhook.topics.1}} == 1")).toContain(
        "if (webhookResult.topics[1] == 1) {"
      );
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
