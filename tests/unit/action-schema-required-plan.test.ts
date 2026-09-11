// The action-catalog disclosure for plan gating (#2279).
//
// The builder's wire projection (ActionSchema) carries `requiredPlan` and
// `featureEnabled` so an agent or API consumer can see, before building a
// workflow, which actions need a paid plan. The requirement is resolved
// through resolveActionFeature - not the static FEATURES table - so the
// egress-derived catch-all gate (action.external-request) is included: a
// plugin that lets the user point at a destination of their choosing is
// pro-gated even though no FEATURES entry names its action types.
//
// The parity suite at the bottom pins the invariant that makes disclosure
// trustworthy: what the catalog advertises must equal what the workflow
// validator enforces for a given plan, action by action.

import { describe, expect, it } from "vitest";

import {
  buildActionSchemasResponse,
  transformPluginAction,
} from "@/lib/action-schemas/builder";
import { validateWorkflowFeatures } from "@/lib/features/workflow-validator";
import { getAllIntegrations } from "@/plugins/registry";

function allPluginSchemas(): ReturnType<typeof transformPluginAction>[] {
  return getAllIntegrations().flatMap((plugin) =>
    plugin.actions.map((action) => transformPluginAction(plugin, action))
  );
}

describe("ActionSchema plan-gate disclosure", () => {
  it("marks explicitly gated plugin actions with their plan", () => {
    const codeAction = allPluginSchemas().find(
      (schema) => schema.actionType === "code/run-code"
    );

    expect(codeAction?.requiredPlan).toBe("pro");
    expect(codeAction?.featureEnabled).toBe(true);
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
      expect(schema.featureEnabled).toBe(true);
    }
  });

  it("leaves protocol-derived actions ungated (fixed-host egress)", () => {
    // Every protocol action is egress "fixed-host" (lib/protocol-registry.ts),
    // never user-destination, so none can be plan-gated. If that one line ever
    // changes, every protocol action silently flips to "pro" - this pins it.
    const protocolActions = allPluginSchemas().filter((schema) =>
      ["aave-v3", "aave-v4", "chronicle", "compound", "morpho", "spark"].some(
        (type) => schema.actionType.startsWith(`${type}/`)
      )
    );

    expect(protocolActions.length).toBeGreaterThan(0);
    for (const schema of protocolActions) {
      expect(
        schema.requiredPlan,
        `${schema.actionType} must stay ungated`
      ).toBeNull();
      expect(schema.featureEnabled).toBe(true);
    }
  });

  it("leaves ungated plugin actions at null", () => {
    const readAction = allPluginSchemas().find(
      (schema) => schema.actionType === "web3/read-contract"
    );

    expect(readAction?.requiredPlan).toBeNull();
    expect(readAction?.featureEnabled).toBe(true);
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
      { requiredPlan: string | null; featureEnabled: boolean }
    >;

    expect(actions["HTTP Request"].requiredPlan).toBe("pro");
    expect(actions["Database Query"].requiredPlan).toBe("pro");
    expect(actions["HTTP Request"].featureEnabled).toBe(true);
    expect(actions["Database Query"].featureEnabled).toBe(true);
  });

  it("leaves ungated system actions at null", async () => {
    const response = await buildActionSchemasResponse({
      includeChains: false,
      category: "system",
      endpointLabel: "test",
    });
    const actions = response.actions as Record<
      string,
      { requiredPlan: string | null; featureEnabled: boolean }
    >;

    expect(actions.Condition.requiredPlan).toBeNull();
    expect(actions["For Each"].requiredPlan).toBeNull();
    expect(actions.Condition.featureEnabled).toBe(true);
  });
});

describe("disclosure equals enforcement", () => {
  // The invariant #2279 exists to establish: what the catalog advertises for
  // an action must be exactly what the workflow validator enforces. If the
  // builder and the validator ever resolve through different functions (e.g.
  // one reads ACTION_TYPE_TO_FEATURE_ID and the other resolveActionFeature),
  // an action can advertise "pro" while a free org saves it - or vice versa -
  // with no test failing. Every registered action is checked on a free org:
  // an action is disclosed as gated exactly when the validator would flag it.
  it("advertises gated exactly when a free org would be blocked", () => {
    // Recompute per action using the validator's own resolver on a
    // single-node workflow: an action is disclosed as gated exactly when the
    // validator would flag it on a free org.
    for (const schema of allPluginSchemas()) {
      const violations = validateWorkflowFeatures(
        [
          {
            id: `probe-${schema.actionType}`,
            actionType: schema.actionType,
          },
        ],
        "free"
      );
      const blocked = violations.length > 0;
      expect(
        blocked,
        `${schema.actionType}: advertised requiredPlan=${schema.requiredPlan} but enforcement says ${blocked ? "blocked" : "allowed"}`
      ).toBe(schema.requiredPlan !== null);
    }
  });
});
