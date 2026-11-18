import { describe, expect, it } from "vitest";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import type { ConditionOperator } from "@/lib/workflow/nodes/condition/builder-types";
import {
  OPERATOR_GROUPS,
  OPERATOR_METADATA,
  operatorsForCategory,
} from "@/lib/workflow/nodes/condition/operator-metadata";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { filterArray } from "@/plugins/data/steps/filter-core";
import {
  FILTER_OPERATOR_OPTIONS,
  KEEP_ALL_OPERATOR,
  PRESENCE_FILTER_OPERATORS,
  VALUE_FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS,
} from "@/plugins/data/steps/filter-operators";
import {
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
} from "@/plugins/registry";

const ACTION_TYPE = "data/filter";

const CONDITION_OPERATORS = Object.keys(
  OPERATOR_METADATA
) as ConditionOperator[];

function fields() {
  const action = findActionById(ACTION_TYPE);
  if (!action?.configFields) {
    throw new Error(`${ACTION_TYPE} has no config fields`);
  }
  return flattenConfigFields(action.configFields);
}

function field(key: string) {
  const found = fields().find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`${ACTION_TYPE} has no ${key} field`);
  }
  return found;
}

function editorConfig(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...buildConfigForActionTypeChange(ACTION_TYPE, {}), ...overrides };
}

function visibleKeys(config: Record<string, unknown>): string[] {
  return fields()
    .filter((candidate) => evaluateShowWhen(candidate.showWhen, config))
    .map((candidate) => candidate.key);
}

function actionNode(config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      label: "Filter",
      type: "action",
      config: { actionType: ACTION_TYPE, ...config },
    },
  };
}

describe("data/filter definition", () => {
  describe("operator options", () => {
    it("offers every Condition operator, the four negations and keep every item", () => {
      const offered = FILTER_OPERATOR_OPTIONS.map((option) => option.value);
      const expected = [
        ...CONDITION_OPERATORS,
        "notContains",
        "notStartsWith",
        "notEndsWith",
        "notMatchesRegex",
        KEEP_ALL_OPERATOR,
      ];
      expect([...offered].sort()).toEqual([...expected].sort());
    });

    it("hides Value for exactly the operators Condition treats as unary", () => {
      const expected = [
        ...CONDITION_OPERATORS.filter((op) => OPERATOR_METADATA[op].unary),
        KEEP_ALL_OPERATOR,
      ];
      expect([...VALUELESS_FILTER_OPERATORS].sort()).toEqual(
        [...expected].sort()
      );
    });

    it("has no duplicate value, nor a repeated label within a group", () => {
      const values = FILTER_OPERATOR_OPTIONS.map((option) => option.value);
      const labels = FILTER_OPERATOR_OPTIONS.map(
        (option) => `${option.group}/${option.label}`
      );
      expect(new Set(values).size).toBe(values.length);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it("uses Condition's labels, groups and order, each negation after its test", () => {
      const conditionOrder = OPERATOR_GROUPS.flatMap((group) =>
        operatorsForCategory(group.category)
      );
      const conditionOptions = FILTER_OPERATOR_OPTIONS.filter(
        (option) => option.value in OPERATOR_METADATA
      );
      expect(conditionOptions.map((option) => option.value)).toEqual(
        conditionOrder
      );
      for (const option of conditionOptions) {
        const meta = OPERATOR_METADATA[option.value as ConditionOperator];
        expect(option.label).toBe(meta.label);
        expect(option.description).not.toBe("");
        expect(
          OPERATOR_GROUPS.find((group) => group.category === meta.category)
            ?.label
        ).toBe(option.group);
      }
      const values = FILTER_OPERATOR_OPTIONS.map((option) => option.value);
      for (const [negation, base] of [
        ["notContains", "contains"],
        ["notStartsWith", "startsWith"],
        ["notEndsWith", "endsWith"],
        ["notMatchesRegex", "matchesRegex"],
      ]) {
        expect(values.indexOf(negation as never)).toBe(
          values.indexOf(base as never) + 1
        );
      }
      expect(FILTER_OPERATOR_OPTIONS.at(-1)?.value).toBe(KEEP_ALL_OPERATOR);
    });

    it("keeps Condition's hint where Filter tests the same way", () => {
      for (const op of ["===", "isNull", "arrayContains", "objectHasKey"]) {
        const option = FILTER_OPERATOR_OPTIONS.find((o) => o.value === op);
        expect(option?.description).toBe(
          OPERATOR_METADATA[op as ConditionOperator].description
        );
      }
    });

    it("puts every operator in exactly one handling group", () => {
      for (const option of FILTER_OPERATOR_OPTIONS) {
        const groups = [
          VALUELESS_FILTER_OPERATORS,
          VALUE_FILTER_OPERATORS,
        ].filter((list) => list.includes(option.value));
        expect(groups, option.value).toHaveLength(1);
      }
    });

    it("puts the grouped options on the select, defaulting to equals", () => {
      const operator = field("operator");
      expect(operator.options).toEqual(
        FILTER_OPERATOR_OPTIONS.map(({ value, label, group, description }) => ({
          value,
          label,
          group,
          description,
        }))
      );
      expect(operator.defaultValue).toBe("===");
      expect(operator.required).toBe(true);
    });
  });

  describe("field visibility", () => {
    it("shows Value and Ignore case for a comparison", () => {
      expect(visibleKeys(editorConfig())).toEqual([
        "source",
        "field",
        "operator",
        "value",
        "ignoreCase",
        "returnField",
        "missingReturn",
        "labels",
        "untestable",
      ]);
      expect(visibleKeys(editorConfig({ operator: "startsWith" }))).toContain(
        "value"
      );
    });

    it("shows Ignore case only where it applies", () => {
      expect(visibleKeys(editorConfig({ operator: ">" }))).not.toContain(
        "ignoreCase"
      );
      expect(visibleKeys(editorConfig({ operator: "isTrue" }))).not.toContain(
        "ignoreCase"
      );
      expect(
        visibleKeys(editorConfig({ operator: "arrayContains" }))
      ).toContain("ignoreCase");
    });

    it("hides Field to test for keep every item", () => {
      expect(
        visibleKeys(editorConfig({ operator: KEEP_ALL_OPERATOR }))
      ).toEqual([
        "source",
        "operator",
        "returnField",
        "missingReturn",
        "labels",
      ]);
    });

    it("renders Ignore case as a switch that starts off", () => {
      expect(field("ignoreCase").type).toBe("switch");
      expect(field("ignoreCase").defaultValue).toBe("false");
    });

    it("hides Value for a test that takes none", () => {
      for (const operator of VALUELESS_FILTER_OPERATORS) {
        expect(visibleKeys(editorConfig({ operator })), operator).not.toContain(
          "value"
        );
      }
    });
  });

  describe("save-time validation", () => {
    it("accepts the Chainlog example", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "{{@node1:Chainlog.result}}",
            operator: "startsWith",
            value: "EMSP_",
          })
        ),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a pluck with Keep every item", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "{{@node1:Batch.results}}",
            operator: KEEP_ALL_OPERATOR,
            returnField: "result",
          })
        ),
      ]);
      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("requires the source", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(editorConfig({ operator: "isTrue" })),
      ]);
      expect(result.valid).toBe(false);
    });

    it("refuses a regex pattern from another node, but not a compared value", () => {
      for (const operator of ["matchesRegex", "notMatchesRegex"]) {
        const result = validateWorkflowActionConfigs([
          actionNode(
            editorConfig({
              source: "{{@node1:Chainlog.result}}",
              operator,
              value: "{{@node2:Webhook.pattern}}",
            })
          ),
        ]);
        expect(result.valid, operator).toBe(false);
        expect(JSON.stringify(result.issues), operator).toContain(
          "can't come from another node"
        );
      }
      const compared = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "{{@node1:Chainlog.result}}",
            operator: "startsWith",
            value: "{{@node2:Webhook.prefix}}",
          })
        ),
      ]);
      expect(compared).toEqual({ valid: true, issues: [] });
    });

    it("refuses a regex pattern that cannot run when saved", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "{{@node1:Chainlog.result}}",
            operator: "matchesRegex",
            value: "^(?=EMSP)",
          })
        ),
      ]);
      expect(JSON.stringify(result.issues)).toContain(
        "Lookahead and lookbehind"
      );
    });
  });

  describe("AI prompt example", () => {
    it("is a config the step runs", () => {
      const line = generateAIActionPrompts()
        .split("\n")
        .find((entry) => entry.includes(`(${ACTION_TYPE}): `));
      if (!line) {
        throw new Error(`no prompt line for ${ACTION_TYPE}`);
      }
      const example = JSON.parse(line.slice(line.indexOf("{"))) as {
        source: string;
        operator: string;
      };
      expect(example.operator).toBe("isTrue");
      expect(filterArray(example)).toMatchObject({ success: true, count: 1 });
    });
  });

  describe("round 1 form fixes", () => {
    it("shows Value when no operator is stored, since the step defaults to equals", () => {
      expect(visibleKeys({})).toContain("value");
      expect(visibleKeys({})).toContain("ignoreCase");
    });

    it("hides If an item can't be tested where nothing can be skipped", () => {
      for (const operator of [
        KEEP_ALL_OPERATOR,
        ...PRESENCE_FILTER_OPERATORS,
      ]) {
        expect(visibleKeys(editorConfig({ operator })), operator).not.toContain(
          "untestable"
        );
      }
      expect(visibleKeys(editorConfig({ operator: ">" }))).toContain(
        "untestable"
      );
    });

    it("requires Value at save only for tests that take one", () => {
      const missing = validateWorkflowActionConfigs([
        actionNode(editorConfig({ source: "[1]", operator: "===" })),
      ]);
      expect(missing.valid).toBe(false);
      const unset = validateWorkflowActionConfigs([
        actionNode({ source: "[1]" }),
      ]);
      expect(unset.valid).toBe(false);
      const unary = validateWorkflowActionConfigs([
        actionNode(editorConfig({ source: "[1]", operator: "isTrue" })),
      ]);
      expect(unary).toEqual({ valid: true, issues: [] });
    });

    it("checks Ignore case is a boolean at save", () => {
      const bad = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({ source: "[1]", value: "1", ignoreCase: "yes" })
        ),
      ]);
      expect(bad.valid).toBe(false);
      for (const ignoreCase of [true, false, "true", "false"]) {
        const good = validateWorkflowActionConfigs([
          actionNode(editorConfig({ source: "[1]", value: "1", ignoreCase })),
        ]);
        expect(good, String(ignoreCase)).toEqual({ valid: true, issues: [] });
      }
    });

    it("lists indexes and skipped among the outputs", () => {
      const outputs = findActionById(ACTION_TYPE)?.outputFields?.map(
        (output) => output.field
      );
      expect(outputs).toEqual(
        expect.arrayContaining(["indexes", "skipped", "values", "count"])
      );
    });
  });

  describe("round 2 save-time checks", () => {
    function issuesFor(config: Record<string, unknown>) {
      return validateWorkflowActionConfigs([
        actionNode(editorConfig({ source: "[1]", ...config })),
      ]).issues;
    }

    it("refuses at save a Value the step would refuse every run", () => {
      const cases: Record<string, unknown>[] = [
        { operator: "arrayLength", value: "abc" },
        { operator: "arrayLength", value: "3.5" },
        { operator: ">", value: "abc" },
        { operator: ">", value: "1e3" },
        { operator: "===", value: 1e21 },
        { operator: ">", value: "9".repeat(101) },
      ];
      for (const config of cases) {
        const issues = issuesFor(config);
        expect(issues, JSON.stringify(config)).toHaveLength(1);
        expect(issues[0]).toMatchObject({
          code: "INVALID_FIELD_VALUE",
          field: "value",
        });
      }
    });

    it("leaves a templated Value to the run", () => {
      expect(
        issuesFor({ operator: ">", value: "{{@n1:Read.threshold}}" })
      ).toEqual([]);
    });

    it("refuses Labels that are not a list, unless templated", () => {
      expect(
        issuesFor({ operator: "keepAll", labels: "abc" })[0]
      ).toMatchObject({ code: "INVALID_FIELD_VALUE", field: "labels" });
      expect(
        issuesFor({ operator: "keepAll", labels: "{{@n1:Names.values}}" })
      ).toEqual([]);
    });

    it("does not check settings the form hides", () => {
      expect(issuesFor({ operator: "isTrue", ignoreCase: "yes" })).toEqual([]);
    });

    it("leaves the AI prompt example free of placeholder text", () => {
      expect(field("labels").defaultValue).toBe("");
      expect(field("returnField").defaultValue).toBe("");
    });
  });

  describe("round 3 save-time checks", () => {
    function issuesFor(config: Record<string, unknown>) {
      return validateWorkflowActionConfigs([
        actionNode(editorConfig({ operator: "keepAll", ...config })),
      ]).issues;
    }

    it("defaults If an item can't be tested to fail", () => {
      expect(field("untestable").defaultValue).toBe("fail");
      expect(field("missingReturn").defaultValue).toBe("keep");
    });

    it("refuses a typed Source that is not a list", () => {
      for (const source of ["abc", '{"a": 1}']) {
        expect(issuesFor({ source })[0], source).toMatchObject({
          code: "INVALID_FIELD_VALUE",
          field: "source",
        });
      }
      expect(issuesFor({ source: "{{@n1:Read.results}}" })).toEqual([]);
    });

    it("checks Labels against a typed Source", () => {
      expect(issuesFor({ source: "[1, 2]", labels: '["a"]' })[0]).toMatchObject(
        { code: "INVALID_FIELD_VALUE", field: "labels" }
      );
      expect(
        issuesFor({ source: "{{@n1:Read.results}}", labels: '["a"]' })
      ).toEqual([]);
    });

    it("refuses a path with an empty part", () => {
      expect(
        issuesFor({ source: "[1]", returnField: "a..b" })[0]
      ).toMatchObject({ field: "returnField" });
    });

    it("stays fast on a value full of opening braces", () => {
      const value = "{{".repeat(80_000);
      const started = performance.now();
      issuesFor({
        source: "[1]",
        operator: "startsWith",
        value,
        labels: value,
      });
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("round 5 save-time checks", () => {
    it("leaves a templated path to the run", () => {
      const issues = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "[1]",
            operator: "keepAll",
            returnField: "{{@n1:Read.path}}..x",
          })
        ),
      ]).issues;
      expect(issues).toEqual([]);
    });
  });
});
