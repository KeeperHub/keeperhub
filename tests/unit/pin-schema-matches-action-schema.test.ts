// The MCP pin schema and the action schema describe the same config fields to
// agents. Two hand-written mappings drifted once (#2777: two toggles were
// boolean in one and string in the other), and again the other way round for
// Solidity bool inputs (#2781), so this sweeps every registered action and
// holds every field to one JSON type in both.

import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { transformPluginAction } from "@/lib/action-schemas/builder";
import { preparePinDataForWorkflow } from "@/lib/mcp/prepare-test-pin-data";
import { resolveFailOnError } from "@/lib/utils";
import { resolveSponsorGas } from "@/lib/web3/sponsorship-feature-flag";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { readSettings } from "@/plugins/data/filter-config";
import {
  type ActionConfigFieldBase,
  computeActionId,
  fieldEnumValues,
  fieldJsonType,
  flattenConfigFields,
  getAllIntegrations,
  isDisplayOnlyField,
  isToggleField,
  toggleDefault,
} from "@/plugins/registry";

type FieldCase = {
  actionType: string;
  key: string;
  type: string;
  actionSchemaType: string;
  pinType: string | undefined;
  pinDefault: unknown;
  pinEnum: string[] | undefined;
  enumValues: string[] | undefined;
  hasOptions: boolean;
  defaultValue: string | undefined;
};

// What each plain switch's step does with the field unset, read through the
// step's own settings parser. A new plain switch needs an entry here.
const PLAIN_SWITCH_STEP_READERS: Record<string, () => boolean> = {
  "data/filter.ignoreCase": () =>
    readSettings({ source: "[]", operator: "===", value: "a" }).ignoreCase,
};

// What an unset toggle means: the default-on resolvers the steps call, and
// for a plain switch the step's own reader above.
const UNSET_RESOLVERS: Record<
  string,
  (field: FieldCase) => boolean | undefined
> = {
  "fail-on-error-switch": () => resolveFailOnError(undefined),
  "gas-sponsorship-switch": () => resolveSponsorGas(undefined),
  switch: (field) =>
    PLAIN_SWITCH_STEP_READERS[`${field.actionType}.${field.key}`]?.(),
};

// Toggle fields the action schema leaves out, so they cannot be compared.
const skippedToggles: string[] = [];

function collectFields(): FieldCase[] {
  const cases: FieldCase[] = [];
  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      const actionType = computeActionId(plugin.type, action.slug);
      const schema = transformPluginAction(plugin, action);
      const described = {
        ...schema.optionalFields,
        ...schema.requiredFields,
      };
      const [pin] = preparePinDataForWorkflow([
        { id: "n", data: { config: { actionType } } },
      ]);
      for (const field of flattenConfigFields(action.configFields ?? [])) {
        if (isDisplayOnlyField(field.type)) {
          continue;
        }
        if (!(field.key in described)) {
          if (isToggleField(field.type)) {
            skippedToggles.push(`${actionType}.${field.key}`);
          }
          continue;
        }
        cases.push({
          actionType,
          key: field.key,
          type: field.type,
          actionSchemaType: described[field.key] ?? "",
          pinType: pin?.pinSchema.properties[field.key]?.type,
          pinDefault: pin?.pinSchema.properties[field.key]?.default,
          pinEnum: pin?.pinSchema.properties[field.key]?.enum,
          enumValues: fieldEnumValues(field),
          hasOptions: (field.options?.length ?? 0) > 0,
          defaultValue: field.defaultValue,
        });
      }
    }
  }
  return cases;
}

// The description is "<type>[ (detail)] - <label>[ - <placeholder>]".
const TYPE_WORD = /^\w+/;

describe("pin schema and action schema agree on field types", () => {
  const cases = collectFields();

  it("gives every field the same JSON type in both schemas", () => {
    expect(cases.length).toBeGreaterThan(0);
    const wrong = cases
      .filter((field) => {
        const expected = fieldJsonType(field.type);
        return (
          field.actionSchemaType.match(TYPE_WORD)?.[0] !== expected ||
          field.pinType !== expected
        );
      })
      .map(
        (field) =>
          `${field.actionType}.${field.key} (${field.type}): action "${field.actionSchemaType.match(TYPE_WORD)?.[0]}", pin "${field.pinType}"`
      );
    expect(wrong).toEqual([]);
  });

  // Same JSON type is not enough: a closed list in one and an open string in
  // the other drifts with both still saying "string".
  it("lists the same closed values in both schemas", () => {
    const wrong: string[] = [];
    for (const field of cases) {
      const at = `${field.actionType}.${field.key}`;
      const [typeText] = field.actionSchemaType.split(" - ");
      if (!isDeepStrictEqual(field.pinEnum, field.enumValues)) {
        wrong.push(`${at}: pin enum ${JSON.stringify(field.pinEnum)}`);
      }
      if (field.pinEnum !== undefined) {
        const listed = field.pinEnum.map((v) => `"${v}"`).join(" | ");
        if (typeText !== `string (${listed || "select"})`) {
          wrong.push(`${at}: action "${typeText}"`);
        }
      } else if (field.hasOptions && !typeText.includes("template")) {
        wrong.push(`${at}: open in the pin schema, closed "${typeText}"`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("finds closed and template-taking option lists to check", () => {
    const withOptions = cases.filter((field) => field.hasOptions);
    expect(withOptions.some((field) => field.pinEnum !== undefined)).toBe(true);
    expect(withOptions.some((field) => field.pinEnum === undefined)).toBe(true);
  });

  it("treats a select with no options as open, not as an enum of nothing", () => {
    for (const options of [undefined, []]) {
      const field: ActionConfigFieldBase = {
        key: "k",
        label: "K",
        type: "select",
        options,
      };
      expect(fieldEnumValues(field), JSON.stringify(options)).toBeUndefined();
    }
  });

  it("checks fields of every JSON type", () => {
    expect(new Set(cases.map((field) => fieldJsonType(field.type)))).toEqual(
      new Set(["string", "number", "boolean"])
    );
  });

  it("finds the toggle fields it is meant to check", () => {
    const toggles = cases.filter((field) => isToggleField(field.type));
    expect(toggles.length).toBeGreaterThan(0);
    expect(skippedToggles).toEqual([]);
    // Written out on purpose: a new toggle type with no registered field, or
    // no runtime resolver below, fails here instead of going unchecked.
    expect(new Set(toggles.map((field) => field.type))).toEqual(
      new Set(["fail-on-error-switch", "gas-sponsorship-switch", "switch"])
    );
  });

  it("types every toggle as boolean in both schemas", () => {
    const wrong = cases
      .filter((field) => isToggleField(field.type))
      .filter(
        (field) =>
          !field.actionSchemaType.startsWith("boolean") ||
          field.pinType !== "boolean"
      )
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  it("types every Solidity bool input as boolean in both schemas", () => {
    const bools = cases.filter((field) => field.type === "protocol-bool");
    expect(bools.length).toBeGreaterThan(0);
    const wrong = bools
      .filter(
        (field) =>
          !field.actionSchemaType.startsWith("boolean") ||
          field.pinType !== "boolean" ||
          // Only toggles carry a default, as the tool description says.
          field.pinDefault !== undefined
      )
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  // The pin schema stays strict: JSON true/false only.
  it("lists the strings and the template a Solidity bool also takes", () => {
    for (const field of cases.filter((f) => f.type === "protocol-bool")) {
      const at = `${field.actionType}.${field.key}`;
      const [typeText] = field.actionSchemaType.split(" - ");
      expect(typeText, at).toMatch(/^boolean \(/);
      expect(typeText, at).toContain('"true" and "false"');
      expect(typeText, at).toContain("{{@nodeId:Label.field}} template");
      expect(typeText, at).toContain("not in execute_protocol_action");
    }
  });

  it('saves true/false (JSON or string) for a Solidity bool and refuses "yes"', () => {
    const issuesFor = (field: FieldCase, value: unknown): string[] =>
      validateWorkflowActionConfigs([
        {
          id: "n",
          type: "action",
          data: {
            type: "action",
            config: { actionType: field.actionType, [field.key]: value },
          },
        },
      ])
        .issues.filter((issue) => issue.field === field.key)
        .map((issue) => issue.code);
    for (const field of cases.filter((f) => f.type === "protocol-bool")) {
      const at = `${field.actionType}.${field.key}`;
      for (const value of [true, false, "true", "false"]) {
        expect(issuesFor(field, value), `${at} ${value}`).toEqual([]);
      }
      // Saving a template is unchanged.
      expect(issuesFor(field, "{{@a:A.flag}}"), at).toEqual([]);
      expect(issuesFor(field, "yes"), at).not.toEqual([]);
    }
  });

  it("advertises the default each toggle's step applies when unset", () => {
    const wrong = cases
      .filter((field) => isToggleField(field.type))
      .filter((field) => {
        const unset = UNSET_RESOLVERS[field.type]?.(field);
        return unset === undefined || field.pinDefault !== unset;
      })
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  it("has a step reader for every plain switch, and no stale ones", () => {
    const plain = cases
      .filter((field) => field.type === "switch")
      .map((field) => `${field.actionType}.${field.key}`);
    expect(plain.sort()).toEqual(Object.keys(PLAIN_SWITCH_STEP_READERS).sort());
  });

  // Unit check of toggleDefault alone; the sweep above ties it to the step.
  it("reads a plain switch's declared default in toggleDefault", () => {
    for (const defaultValue of ["true", "false", undefined]) {
      const field = {
        key: "s",
        label: "S",
        type: "switch" as const,
        defaultValue,
      };
      expect(toggleDefault(field), String(defaultValue)).toBe(
        defaultValue === "true"
      );
    }
  });

  // Every registered default-on toggle declares defaultValue "true", so the
  // sweep above cannot tell the runtime rule from reading defaultValue.
  it("follows the runtime rule even when a default-on toggle declares false or nothing", () => {
    for (const [type, resolve] of [
      ["fail-on-error-switch", () => resolveFailOnError(undefined)],
      ["gas-sponsorship-switch", () => resolveSponsorGas(undefined)],
    ] as const) {
      for (const defaultValue of ["false", undefined]) {
        const field = { key: "toggle", label: "Toggle", type, defaultValue };
        expect(toggleDefault(field), `${type} ${defaultValue}`).toBe(resolve());
      }
    }
  });
});

describe("pin schema required list", () => {
  it("names each required field once, even when a key is declared per mode", () => {
    const repeated: string[] = [];
    for (const plugin of getAllIntegrations()) {
      for (const action of plugin.actions) {
        const actionType = computeActionId(plugin.type, action.slug);
        const [pin] = preparePinDataForWorkflow([
          { id: "n", data: { config: { actionType } } },
        ]);
        const required = pin?.pinSchema.required ?? [];
        if (new Set(required).size !== required.length) {
          repeated.push(actionType);
        }
      }
    }
    expect(repeated).toEqual([]);
  });
});
