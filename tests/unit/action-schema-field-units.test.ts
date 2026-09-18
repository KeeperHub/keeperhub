// Field descriptions carry the label, so a unit stated there reaches an agent.
//
// Protocol inputs state their unit in the label - "Amount (wei)" - and have
// no placeholder. The builder used to project type and placeholder only, so
// every one of those inputs reached search_protocol_actions as "string",
// while web3/approve-token, whose amount is whole tokens and which happens to
// carry a placeholder, said so. Two adjacent actions in an approve-then-supply
// flow, opposite units, and only one of them visible.
//
// The sweep at the bottom pins the general property: any parenthesised group
// in a field's label - which is where units live - appears in its schema
// description.

import { describe, expect, it } from "vitest";

import { transformPluginAction } from "@/lib/action-schemas/builder";
import { flattenConfigFields, getAllIntegrations } from "@/plugins/registry";

function schemaFor(actionType: string) {
  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      const schema = transformPluginAction(plugin, action);
      if (schema.actionType === actionType) {
        return schema;
      }
    }
  }
  throw new Error(`no action ${actionType}`);
}

// Any parenthesised group, not an enumeration of known units: "(wei/sec)" on
// superfluid's flow rate is a unit too, and a list would silently skip it.
const PARENTHESISED = /\([^)]+\)/;

describe("ActionSchema field descriptions", () => {
  it("carries a unit that is stated only in the label", () => {
    const supply = schemaFor("aave-v3/supply");
    expect(supply.requiredFields.amount).toContain("Amount (wei)");
  });

  it("keeps the type prefix in front of the label", () => {
    const supply = schemaFor("aave-v3/supply");
    expect(supply.requiredFields.amount?.startsWith("string")).toBe(true);
  });

  it("keeps the placeholder after the label when both are present", () => {
    const approve = schemaFor("web3/approve-token");
    const amount = approve.requiredFields.amount ?? "";
    const labelAt = amount.indexOf("Amount");
    const placeholderAt = amount.indexOf('"max"');
    expect(labelAt).toBeGreaterThan(-1);
    expect(placeholderAt).toBeGreaterThan(labelAt);
  });

  it("does not change the shape of requiredFields or optionalFields", () => {
    const supply = schemaFor("aave-v3/supply");
    for (const value of Object.values(supply.requiredFields)) {
      expect(typeof value).toBe("string");
    }
    for (const value of Object.values(supply.optionalFields)) {
      expect(typeof value).toBe("string");
    }
  });

  it("surfaces every parenthesised unit across every plugin action", () => {
    let checked = 0;
    for (const plugin of getAllIntegrations()) {
      for (const action of plugin.actions) {
        const schema = transformPluginAction(plugin, action);
        for (const field of flattenConfigFields(action.configFields)) {
          const unit = PARENTHESISED.exec(field.label)?.[0];
          if (!unit) {
            continue;
          }
          const described =
            schema.requiredFields[field.key] ??
            schema.optionalFields[field.key];
          expect(described, `${schema.actionType}.${field.key}`).toContain(
            unit
          );
          checked += 1;
        }
      }
    }
    // A sweep that matched nothing would pass vacuously. Anything stricter
    // couples the test to the size of the protocol catalog.
    expect(checked).toBeGreaterThan(0);
  });
});
