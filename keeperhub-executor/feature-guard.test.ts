import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../lib/features";
import { isFeatureEnabledForExecutor } from "./feature-guard";

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

describe("isFeatureEnabledForExecutor (low-latency start)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a paid-plan feature", () => {
    expect(FEATURES[FEATURE_ID].requiredPlan).toBe("pro");
    expect(FEATURES[FEATURE_ID].enabled).toBe(true);
  });

  it("is available on every plan when billing is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    const db = dbWithPlan([{ plan: "free" }]);
    await expect(
      isFeatureEnabledForExecutor(db, "org-1", FEATURE_ID)
    ).resolves.toBe(true);
  });

  it.each([
    ["free", false],
    [null, false],
    ["pro", true],
    ["business", true],
    ["enterprise", true],
  ])("plan %s -> %s", async (plan, expected) => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    const db = dbWithPlan([{ plan }]);
    await expect(
      isFeatureEnabledForExecutor(db, "org-1", FEATURE_ID)
    ).resolves.toBe(expected);
  });

  it("treats an organization with no subscription, or none at all, as free", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    await expect(
      isFeatureEnabledForExecutor(dbWithPlan([]), "org-1", FEATURE_ID)
    ).resolves.toBe(false);
    await expect(
      isFeatureEnabledForExecutor(dbWithPlan([]), null, FEATURE_ID)
    ).resolves.toBe(false);
  });

  it("propagates a lookup error so the caller can fall back", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    await expect(
      isFeatureEnabledForExecutor(
        dbWithPlan(new Error("db down")),
        "org-1",
        FEATURE_ID
      )
    ).rejects.toThrow("db down");
  });
});
