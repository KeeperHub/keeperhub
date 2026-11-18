// The MCP pin schema and the action schema describe the same config fields to
// agents. Two hand-written mappings drifted once (#2777: two toggles were
// boolean in one and string in the other), and again the other way round for
// Solidity bool inputs (#2781), so this sweeps every registered action and
// holds them to one answer on which fields are booleans.

import { describe, expect, it } from "vitest";
import { isSwitchOn } from "@/components/workflow/config/plain-switch-field";
import { transformPluginAction } from "@/lib/action-schemas/builder";
import { preparePinDataForWorkflow } from "@/lib/mcp/prepare-test-pin-data";
import { resolveFailOnError } from "@/lib/utils";
import { resolveSponsorGas } from "@/lib/web3/sponsorship-feature-flag";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import {
  computeActionId,
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
  defaultValue: string | undefined;
};

// What an unset toggle means: the default-on resolvers the steps call, and
// for a plain switch the editor's rule, which seeds defaultValue into config.
const UNSET_RESOLVERS: Record<string, (field: FieldCase) => boolean> = {
  "fail-on-error-switch": () => resolveFailOnError(undefined),
  "gas-sponsorship-switch": () => resolveSponsorGas(undefined),
  switch: (field) => isSwitchOn(undefined, field.defaultValue),
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
          defaultValue: field.defaultValue,
        });
      }
    }
  }
  return cases;
}

describe("pin schema and action schema agree on booleans", () => {
  const cases = collectFields();

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
          field.pinType !== "boolean"
      )
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  // The pin schema stays strict: JSON true/false only.
  it("lists the strings a Solidity bool also takes", () => {
    for (const field of cases.filter((f) => f.type === "protocol-bool")) {
      // The description is "<type> - <label>[ - <placeholder>]".
      const [typeText] = field.actionSchemaType.split(" - ");
      expect(typeText, `${field.actionType}.${field.key}`).toBe(
        'boolean (true or false; the strings "true" and "false" also work)'
      );
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

  it("types a field boolean in the action schema wherever the pin schema does", () => {
    const wrong = cases
      .filter((field) => field.pinType === "boolean")
      .filter((field) => !field.actionSchemaType.startsWith("boolean"))
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  it("types a field boolean in the pin schema wherever the action schema does", () => {
    const wrong = cases
      .filter((field) => field.actionSchemaType.startsWith("boolean"))
      .filter((field) => field.pinType !== "boolean")
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
  });

  it("advertises the default each toggle's step applies when unset", () => {
    const wrong = cases
      .filter((field) => isToggleField(field.type))
      .filter((field) => {
        const resolve = UNSET_RESOLVERS[field.type];
        return resolve === undefined || field.pinDefault !== resolve(field);
      })
      .map((field) => `${field.actionType}.${field.key}`);
    expect(wrong).toEqual([]);
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
