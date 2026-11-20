import { describe, expect, it } from "vitest";
import { SYSTEM_ACTIONS } from "@/lib/mcp/workflow-schema-constants";
import { OPERATOR_METADATA } from "@/lib/workflow/nodes/condition/operator-metadata";
import { isSafeConditionExpression } from "@/lib/workflow/nodes/condition/safe-eval";

const TEMPLATE_RE = /\{\{@[^}]+\}\}/g;
const EXAMPLE_RE = /"([^"]*\{\{@[^"]*)"/g;

const { condition } = SYSTEM_ACTIONS.Condition.requiredFields;
const { conditionConfig } = SYSTEM_ACTIONS.Condition.optionalFields;

function examplesOf(description: string): string[] {
  const examples: string[] = [];
  for (const match of description.matchAll(EXAMPLE_RE)) {
    examples.push(match[1]);
  }
  return examples;
}

describe("MCP Condition schema", () => {
  it.each(Object.keys(OPERATOR_METADATA))(
    "conditionConfig lists the %s operator",
    (operator) => {
      expect(conditionConfig).toContain(`"${operator}"`);
    }
  );

  it("condition examples are expressions the evaluator accepts", () => {
    const examples = examplesOf(condition);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      let index = 0;
      const expression = example.replace(TEMPLATE_RE, () => {
        const variable = `__v${index}`;
        index += 1;
        return variable;
      });
      expect(isSafeConditionExpression(expression)).toBe(true);
    }
  });
});
