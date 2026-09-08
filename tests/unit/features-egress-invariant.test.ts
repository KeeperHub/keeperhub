// Recurrence backstop for the egress-gating fix.
//
// These invariants make "a new network-egress action ships ungated" a build
// failure rather than a production incident. They enumerate the real dispatch
// universe (every registered plugin action plus the built-in system actions)
// and assert that (a) every action is classified, (b) every action the user can
// point at a destination of their choosing is plan-gated, and (c) any plugin
// that exposes a user-supplied connection URL is classified accordingly.
//
// Requires the plugin registry to be loaded (and `pnpm discover-plugins` to
// have generated the protocol barrel), so this is intentionally not a pure
// unit test.

import { describe, expect, it } from "vitest";

import {
  getActionEgress,
  getFeatureForActionType,
  isFeatureEnabled,
  resolveActionFeature,
} from "@/lib/features";
import { SYSTEM_ACTION_EGRESS } from "@/lib/features/system-action-capabilities";
import { SYSTEM_ACTION_TYPES } from "@/lib/workflow/executor/system-action-types";
import { getAllActions, getAllIntegrations } from "@/plugins/registry";

describe("egress classification completeness", () => {
  it("classifies every registered plugin action (no unknowns)", () => {
    const unclassified = getAllActions()
      .filter((action) => getActionEgress(action.id) === "unknown")
      .map((action) => action.id);

    expect(unclassified).toEqual([]);
  });

  // The executor's SYSTEM_ACTIONS and SYSTEM_ACTION_EGRESS are both keyed off
  // SYSTEM_ACTION_TYPES via `satisfies` / `Record<SystemActionType, ...>`, so
  // this is enforced at compile time too; the assertion documents it and
  // catches any runtime divergence.
  it("classifies exactly the executor's system actions", () => {
    expect(Object.keys(SYSTEM_ACTION_EGRESS).sort()).toEqual(
      [...SYSTEM_ACTION_TYPES].sort()
    );
  });
});

describe("user-destination actions are plan gated", () => {
  it("gates every user-destination plugin action for the free plan", () => {
    const ungated = getAllActions()
      .filter((action) => getActionEgress(action.id) === "user-destination")
      .filter((action) => {
        const feature = resolveActionFeature(action.id);
        return !feature || isFeatureEnabled(feature.id, "free");
      })
      .map((action) => action.id);

    expect(ungated).toEqual([]);
  });

  it("gates every user-destination system action for the free plan", () => {
    for (const [actionType, tier] of Object.entries(SYSTEM_ACTION_EGRESS)) {
      if (tier !== "user-destination") {
        continue;
      }
      const feature = resolveActionFeature(actionType);
      expect(feature).toBeDefined();
      if (!feature) {
        continue;
      }
      expect(isFeatureEnabled(feature.id, "free")).toBe(false);
    }
  });
});

describe("fixed-host and none actions stay free", () => {
  // The egress fallback must gate ONLY user-destination actions. A fixed-host
  // or none action with no explicit feature must remain ungated, so branded
  // integrations (Slack, Discord, web3, etc.) keep working on the free plan.
  it("does not let the egress fallback gate non-user-destination actions", () => {
    const wronglyGated = getAllActions()
      .filter((action) => {
        const tier = getActionEgress(action.id);
        return tier === "fixed-host" || tier === "none";
      })
      .filter((action) => !getFeatureForActionType(action.id))
      .filter((action) => resolveActionFeature(action.id) !== undefined)
      .map((action) => action.id);

    expect(wronglyGated).toEqual([]);
  });
});

describe("connection URL surfaces are classified", () => {
  it("classifies every plugin that exposes a user-supplied connection URL as user-destination", () => {
    const misclassified = getAllIntegrations()
      .filter((plugin) =>
        plugin.formFields.some((field) => field.type === "url")
      )
      .filter((plugin) => plugin.egress !== "user-destination")
      .map((plugin) => plugin.type);

    expect(misclassified).toEqual([]);
  });
});

describe("known fixtures", () => {
  it("classifies blockscout as user-destination and gates it for free", () => {
    expect(getActionEgress("blockscout/get-address-balance")).toBe(
      "user-destination"
    );
    const feature = resolveActionFeature("blockscout/get-address-balance");
    expect(feature?.id).toBe("action.external-request");
    expect(isFeatureEnabled("action.external-request", "free")).toBe(false);
    expect(isFeatureEnabled("action.external-request", "pro")).toBe(true);
  });
});
