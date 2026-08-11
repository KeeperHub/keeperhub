import { describe, expect, it } from "vitest";

import {
  buildFeatureSnapshot,
  FEATURES,
  type FeatureId,
  getAllFeatures,
  getEnabledFeatureIdsForPlan,
  getFeature,
  getFeatureForActionType,
  getFeaturesByCategory,
  isFeatureEnabled,
  planMeetsRequirement,
} from "@/lib/features";

describe("feature registry", () => {
  it("indexes every defined feature", () => {
    const all = getAllFeatures();
    expect(all.length).toBe(Object.keys(FEATURES).length);
    for (const feature of all) {
      expect(getFeature(feature.id)).toBe(feature);
    }
  });

  it("maps action types to features (system actions)", () => {
    expect(getFeatureForActionType("Database Query")?.id).toBe(
      "action.database-query"
    );
    expect(getFeatureForActionType("HTTP Request")?.id).toBe(
      "action.http-request"
    );
  });

  it("maps plugin action types using the plugin/slug form", () => {
    expect(getFeatureForActionType("code/run-code")?.id).toBe("action.code");
    expect(getFeatureForActionType("webhook/send-webhook")?.id).toBe(
      "action.webhook"
    );
  });

  it("returns undefined for non-gated action types", () => {
    expect(getFeatureForActionType("Condition")).toBeUndefined();
    expect(getFeatureForActionType("nonexistent")).toBeUndefined();
  });

  it("filters by category", () => {
    const workflowActions = getFeaturesByCategory("workflow-action");
    expect(workflowActions.length).toBe(5);
    for (const feature of workflowActions) {
      expect(feature.category).toBe("workflow-action");
    }
  });
});

describe("planMeetsRequirement", () => {
  it("respects the free < pro < business < enterprise hierarchy", () => {
    expect(planMeetsRequirement("free", "free")).toBe(true);
    expect(planMeetsRequirement("free", "pro")).toBe(false);
    expect(planMeetsRequirement("pro", "pro")).toBe(true);
    expect(planMeetsRequirement("pro", "business")).toBe(false);
    expect(planMeetsRequirement("business", "pro")).toBe(true);
    expect(planMeetsRequirement("enterprise", "business")).toBe(true);
    expect(planMeetsRequirement("enterprise", "enterprise")).toBe(true);
  });
});

describe("isFeatureEnabled", () => {
  it("blocks free plan from Pro-gated features", () => {
    expect(isFeatureEnabled("action.database-query", "free")).toBe(false);
    expect(isFeatureEnabled("action.http-request", "free")).toBe(false);
    expect(isFeatureEnabled("action.code", "free")).toBe(false);
    expect(isFeatureEnabled("action.webhook", "free")).toBe(false);
  });

  it("allows pro and above for Pro-gated features", () => {
    for (const plan of ["pro", "business", "enterprise"] as const) {
      expect(isFeatureEnabled("action.database-query", plan)).toBe(true);
      expect(isFeatureEnabled("action.http-request", plan)).toBe(true);
      expect(isFeatureEnabled("action.code", plan)).toBe(true);
      expect(isFeatureEnabled("action.webhook", plan)).toBe(true);
    }
  });
});

describe("getEnabledFeatureIdsForPlan", () => {
  it("returns nothing for free", () => {
    expect(getEnabledFeatureIdsForPlan("free")).toEqual([]);
  });

  it("returns all pro+ features for pro+", () => {
    const expected: FeatureId[] = [
      "action.database-query",
      "action.http-request",
      "action.code",
      "action.webhook",
      "action.external-request",
      "notifications.execution-digest",
    ];
    for (const plan of ["pro", "business", "enterprise"] as const) {
      const ids = getEnabledFeatureIdsForPlan(plan);
      expect(ids.sort()).toEqual([...expected].sort());
    }
  });
});

describe("buildFeatureSnapshot", () => {
  it("includes plan, enabled ids, and full feature list", () => {
    const snapshot = buildFeatureSnapshot("free");
    expect(snapshot.plan).toBe("free");
    expect(snapshot.enabledFeatureIds).toEqual([]);
    expect(snapshot.features.length).toBe(Object.keys(FEATURES).length);
  });
});
