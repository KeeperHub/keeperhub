import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../lib/features";
import {
  checkWorkflowFeaturesForExecutor,
  featureEnabledForPlan,
} from "./feature-guard";

const FEATURE_ID = "automation.low-latency-start" as const;

// The query builder chain the plan lookup uses, ending in the given rows.
function dbWithPlan(
  rows: Array<{ plan: string | null }> | Error
): PostgresJsDatabase<Record<string, unknown>> {
  const limit = vi.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
  );
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => ({ limit })),
  };
  return chain as unknown as PostgresJsDatabase<Record<string, unknown>>;
}

describe("low-latency start entitlement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a paid-plan feature", () => {
    expect(FEATURES[FEATURE_ID].requiredPlan).toBe("pro");
    expect(FEATURES[FEATURE_ID].enabled).toBe(true);
  });

  it.each([
    ["free", false],
    ["pro", true],
    ["business", true],
    ["enterprise", true],
    [undefined, true],
  ] as const)("plan %s -> %s (undefined: billing disabled)", (plan, expected) => {
    expect(featureEnabledForPlan(FEATURE_ID, plan)).toBe(expected);
  });

  it("returns the plan it read, so the dispatch path needs no second query", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    const result = await checkWorkflowFeaturesForExecutor(
      dbWithPlan([{ plan: "pro" }]),
      "org-1",
      []
    );
    expect(result.plan).toBe("pro");
    expect(featureEnabledForPlan(FEATURE_ID, result.plan)).toBe(true);
  });

  it("treats an organization with no subscription, or none at all, as free", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    for (const organizationId of ["org-1", null]) {
      const result = await checkWorkflowFeaturesForExecutor(
        dbWithPlan([]),
        organizationId,
        []
      );
      expect(result.plan).toBe("free");
      expect(featureEnabledForPlan(FEATURE_ID, result.plan)).toBe(false);
    }
  });

  it("reports no plan when billing is disabled, so every feature is available", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    const result = await checkWorkflowFeaturesForExecutor(
      dbWithPlan(new Error("must not be queried")),
      "org-1",
      []
    );
    expect(result.plan).toBeUndefined();
    expect(featureEnabledForPlan(FEATURE_ID, result.plan)).toBe(true);
  });
});
