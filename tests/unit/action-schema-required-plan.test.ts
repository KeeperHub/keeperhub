// The action-catalog disclosure for plan gating (#2279).
//
// The builder's wire projection (ActionSchema) carries `requiredPlan` so an
// agent or API consumer can see, before building a workflow, which actions
// need a paid plan. The requirement is resolved through resolveActionFeature
// - not the static FEATURES table - so the egress-derived catch-all gate
// (action.external-request) is included: a plugin that lets the user point at
// a destination of their choosing is pro-gated even though no FEATURES entry
// names its action types.

import { describe, expect, it } from "vitest";

import {
  buildActionSchemasResponse,
  transformPluginAction,
} from "@/lib/action-schemas/builder";
import { getAllIntegrations } from "@/plugins/registry";

describe("ActionSchema requiredPlan disclosure", () => {
  it("marks explicitly gated plugin actions with their plan", () => {
    const codeAction = getAllIntegrations()
      .flatMap((plugin) =>
        plugin.actions.map((action) => transformPluginAction(plugin, action))
      )
      .find((schema) => schema.actionType === "code/run-code");

    expect(codeAction?.requiredPlan).toBe("pro");
  });

  it("marks egress-gated plugin actions via the catch-all (no FEATURES entry)", () => {
    // blockscout declares egress: "user-destination" and has no explicit
    // FEATURES[].actionTypes entry, so only resolveActionFeature's catch-all
    // can disclose its gate. Regression guard for #2279.
    const blockscoutActions = getAllIntegrations()
      .filter((plugin) => plugin.type === "blockscout")
      .flatMap((plugin) =>
        plugin.actions.map((action) => transformPluginAction(plugin, action))
      );

    expect(blockscoutActions.length).toBeGreaterThan(0);
    for (const schema of blockscoutActions) {
      expect(schema.requiredPlan).toBe("pro");
    }
  });

  it("leaves ungated plugin actions at null", () => {
    const readAction = getAllIntegrations()
      .flatMap((plugin) =>
        plugin.actions.map((action) => transformPluginAction(plugin, action))
      )
      .find((schema) => schema.actionType === "web3/read-contract");

    expect(readAction?.requiredPlan).toBeNull();
  });
});

describe("buildActionSchemasResponse system-action disclosure", () => {
  it("discloses requiredPlan on the plan-gated system actions", async () => {
    const response = await buildActionSchemasResponse({
      includeChains: false,
      category: "system",
      endpointLabel: "test",
    });
    const actions = response.actions as Record<
      string,
      { actionType: string; requiredPlan: string | null }
    >;

    expect(actions["HTTP Request"].requiredPlan).toBe("pro");
    expect(actions["Database Query"].requiredPlan).toBe("pro");
  });

  it("leaves ungated system actions at null", async () => {
    const response = await buildActionSchemasResponse({
      includeChains: false,
      category: "system",
      endpointLabel: "test",
    });
    const actions = response.actions as Record<
      string,
      { actionType: string; requiredPlan: string | null }
    >;

    expect(actions.Condition.requiredPlan).toBeNull();
    expect(actions["For Each"].requiredPlan).toBeNull();
  });
});
