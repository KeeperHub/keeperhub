import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import type { ConditionOperator } from "@/lib/workflow/nodes/condition/builder-types";
import {
  OPERATOR_GROUPS,
  OPERATOR_METADATA,
  operatorsForCategory,
} from "@/lib/workflow/nodes/condition/operator-metadata";
import {
  formatActionConfigValidationResponse,
  validateWorkflowActionConfigs,
} from "@/lib/workflow/validation/action-config";
import {
  checkFilterConfig,
  IGNORE_CASE_DEFAULT,
} from "@/plugins/data/filter-config";
import {
  FILTER_OPERATOR_OPTIONS,
  filterOperatorRule,
  filterOperatorsWhere,
  KEEP_ALL_OPERATOR,
} from "@/plugins/data/filter-operators";
import { filterArray } from "@/plugins/data/steps/filter-core";
import {
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
} from "@/plugins/registry";

const ACTION_TYPE = "data/filter";
const ROOT = join(import.meta.dirname, "..", "..");
// `import x from "y"`, `export ... from "y"` and `import "y"`, with either
// quote and with or without a semicolon; not `import type`.
const IMPORT_RE =
  /^(?:(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+|import\s+)["']([^"']+)["']/gm;

const VALUELESS_FILTER_OPERATORS = filterOperatorsWhere(
  (rule) => !rule.readsValue
);
const PRESENCE_FILTER_OPERATORS = filterOperatorsWhere(
  (rule) => rule.test === "presence"
);

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
    it("offers every Condition operator except matches regex, the three negations and keep every item", () => {
      const offered = FILTER_OPERATOR_OPTIONS.map((option) => option.value);
      const expected = [
        ...CONDITION_OPERATORS.filter((op) => op !== "matchesRegex"),
        "notContains",
        "notStartsWith",
        "notEndsWith",
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
      ).filter((op) => op !== "matchesRegex");
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

    it("shows Value exactly for the operators that are not valueless", () => {
      const value = field("value");
      for (const option of FILTER_OPERATOR_OPTIONS) {
        const takesValue = !VALUELESS_FILTER_OPERATORS.includes(option.value);
        expect(
          evaluateShowWhen(value.showWhen, { operator: option.value }),
          option.value
        ).toBe(takesValue);
      }
    });

    it("puts the grouped options on the select, defaulting to equals", () => {
      const operator = field("operator");
      expect(operator.options).toEqual([...FILTER_OPERATOR_OPTIONS]);
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

  describe("save errors and what the definition loads", () => {
    it("puts the cross-field reason in the 422 summary the editor shows", () => {
      const validation = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({ source: "[1]", operator: ">", value: "abc" })
        ),
      ]);
      expect(formatActionConfigValidationResponse(validation).message).toBe(
        "Workflow contains invalid action configuration. Invalid node(s): \"Filter\": Value for 'Number: greater than' must be a number, e.g. 100 or 0x64. Fix the listed fields and save again."
      );
    });

    it("parts entries on a semicolon when one quotes a reason", () => {
      const bad = (id: string, label: string) => ({
        ...actionNode(
          editorConfig({ source: "[1]", operator: ">", value: "abc" })
        ),
        id,
        data: {
          ...actionNode(
            editorConfig({ source: "[1]", operator: ">", value: "abc" })
          ).data,
          label,
        },
      });
      const validation = validateWorkflowActionConfigs([
        bad("n1", "A"),
        bad("n2", "B"),
        {
          id: "n3",
          type: "action",
          data: {
            label: "C",
            type: "action",
            config: {
              actionType: "data/filter",
              source: "[1]",
              operator: "nope",
            },
          },
        },
      ]);
      const reason =
        "Value for 'Number: greater than' must be a number, e.g. 100 or 0x64";
      expect(formatActionConfigValidationResponse(validation).message).toBe(
        `Workflow contains invalid action configuration. Invalid node(s): "A": ${reason}; "B": ${reason}; "C" (operator, value). Fix the listed fields and save again.`
      );
    });

    it("parts entries on a comma when no shown entry quotes a reason", () => {
      const node = (id: string, config: Record<string, unknown>) => ({
        id,
        type: "action",
        data: {
          label: id,
          type: "action",
          config: { actionType: "data/filter", source: "[1]", ...config },
        },
      });
      const validation = validateWorkflowActionConfigs([
        node("A", { operator: "nope" }),
        node("B", { operator: "nope" }),
        node("C", { operator: "nope" }),
        node("D", {
          ...editorConfig(),
          source: "[1]",
          operator: ">",
          value: "abc",
        }),
      ]);
      expect(formatActionConfigValidationResponse(validation).message).toBe(
        'Workflow contains invalid action configuration. Invalid node(s): "A" (operator, value), "B" (operator, value), "C" (operator, value), and 1 more. Fix the listed fields and save again.'
      );
    });

    it("names a node with a blank label by its id in the summary", () => {
      const node = actionNode(
        editorConfig({ source: "[1]", operator: ">", value: "abc" })
      );
      node.data.label = "   ";
      const validation = validateWorkflowActionConfigs([node]);
      expect(
        formatActionConfigValidationResponse(validation).message
      ).toContain('Invalid node(s): "node-1": Value for');
    });

    it("keeps the condition evaluator out of what the plugin definition loads", () => {
      const loaded = runtimeImports("plugins/data/index.ts");
      for (const heavy of [
        "plugins/data/steps/filter-core.ts",
        "lib/workflow/nodes/condition/safe-eval.ts",
        "lib/workflow/nodes/condition/expression.ts",
      ]) {
        expect(loaded, heavy).not.toContain(heavy);
      }
      expect(loaded).toContain("plugins/data/filter-config.ts");
    });
  });
  describe("second review fixes", () => {
    const RULE_FIELDS = {
      field: "readsField",
      value: "readsValue",
      ignoreCase: "readsIgnoreCase",
      untestable: "canSkip",
    } as const;
    type RuleField = keyof typeof RULE_FIELDS;

    it("shows each operator-dependent field exactly where the step reads it", () => {
      for (const option of FILTER_OPERATOR_OPTIONS) {
        const rule = filterOperatorRule(option.value);
        const shown = visibleKeys({ operator: option.value });
        for (const key of Object.keys(RULE_FIELDS) as RuleField[]) {
          expect(shown.includes(key), `${option.value} ${key}`).toBe(
            rule[RULE_FIELDS[key]]
          );
        }
      }
    });

    it("checks at save only the settings the operator reads", () => {
      for (const option of FILTER_OPERATOR_OPTIONS) {
        const rule = filterOperatorRule(option.value);
        const read = (Object.keys(RULE_FIELDS) as RuleField[]).filter(
          (key) => rule[RULE_FIELDS[key]]
        );
        // Each bad setting alone: refused exactly when the operator reads it.
        const bad: Record<RuleField, unknown> = {
          field: "a..b",
          value: "",
          ignoreCase: "maybe",
          untestable: "maybe",
        };
        for (const key of Object.keys(bad) as RuleField[]) {
          const issue = checkFilterConfig({
            source: "[1]",
            operator: option.value,
            value: "1",
            [key]: bad[key],
          });
          expect(issue?.field, `${option.value} ${key}`).toBe(
            read.includes(key) ? key : undefined
          );
        }
      }
    });

    it("refuses a template in Ignore case at save", () => {
      const validation = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: "[1]",
            value: "1",
            ignoreCase: "{{@cfg:Cfg.result.ignoreCase}}",
          })
        ),
      ]);
      expect(validation.valid).toBe(false);
      expect(validation.issues.map((issue) => issue.field)).toEqual([
        "ignoreCase",
      ]);
    });

    it("does not echo a typed Source back in a cross-field issue", () => {
      const validation = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({
            source: JSON.stringify([0, 1, 2, 3, 4]),
            value: "1",
            labels: '["a", "b", "c"]',
          })
        ),
      ]);
      expect(validation.issues).toHaveLength(1);
      expect(validation.issues[0]).not.toHaveProperty("received");
      expect(validation.issues[0].message).toContain(
        "Labels has 3 entries but Source has 5"
      );
    });

    it("declares Ignore case with the default the step applies", () => {
      expect(field("ignoreCase").defaultValue).toBe(IGNORE_CASE_DEFAULT);
    });
  });
});

// Every module a file loads at run time, following value imports only (type
// imports are erased), resolved to repo-relative paths.
function runtimeImports(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) {
        pending.push(resolved);
      }
    }
  }
  return [...seen];
}

function resolveImport(from: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) {
    base = spec.slice(2);
  } else if (spec.startsWith(".")) {
    base = join(dirname(from), spec);
  } else {
    return;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(join(ROOT, candidate))) {
      return candidate;
    }
  }
  return;
}
