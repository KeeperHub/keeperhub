/**
 * KEEP-1042: the rules that decide how long execution data lives. Pure
 * functions only -- config parsing, the per-organization window, and the
 * grouping that keeps the per-org pass a narrow scan. The database side is
 * covered by tests/integration/retention-route.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { daysBefore, getRetentionConfig } from "@/lib/retention/config";
import {
  groupByRetentionWindow,
  resolveRetentionDays,
} from "@/lib/retention/org-windows";

const RETENTION_ENV_KEYS = [
  "EXECUTION_RETENTION_ENABLED",
  "EXECUTION_RETENTION_DRY_RUN",
  "EXECUTION_RETENTION_DEFAULT_DAYS",
  "EXECUTION_RETENTION_MIN_DAYS",
  "EXECUTION_RETENTION_LOOKBACK_DAYS",
  "EXECUTION_LOG_FLOOR_RETENTION_DAYS",
  "EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS",
  "EXECUTION_RETENTION_DAYS",
  "EXECUTION_RETENTION_SOFT_DELETE_GRACE_DAYS",
  "EXECUTION_RETENTION_BATCH_SIZE",
  "EXECUTION_RETENTION_MAX_RUNTIME_SECONDS",
] as const;

afterEach(() => {
  for (const key of RETENTION_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("getRetentionConfig", () => {
  it("is off by default, so deploying the job changes nothing", () => {
    expect(getRetentionConfig().enabled).toBe(false);
  });

  it("carries the documented defaults", () => {
    const config = getRetentionConfig();

    expect(config).toMatchObject({
      dryRun: false,
      defaultLogRetentionDays: 7,
      minLogRetentionDays: 7,
      lookbackDays: 7,
      executionLogFloorRetentionDays: 400,
      outputRawRetentionDays: 7,
      executionRetentionDays: 400,
      softDeleteGraceDays: 30,
      batchSize: 5000,
      maxRuntimeMs: 240_000,
    });
  });

  it("reads every window from the environment", () => {
    process.env.EXECUTION_RETENTION_ENABLED = "true";
    process.env.EXECUTION_RETENTION_DRY_RUN = "true";
    process.env.EXECUTION_RETENTION_MIN_DAYS = "3";
    process.env.EXECUTION_RETENTION_DEFAULT_DAYS = "14";
    process.env.EXECUTION_RETENTION_LOOKBACK_DAYS = "2";
    process.env.EXECUTION_LOG_FLOOR_RETENTION_DAYS = "180";
    process.env.EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS = "5";
    process.env.EXECUTION_RETENTION_DAYS = "500";
    process.env.EXECUTION_RETENTION_SOFT_DELETE_GRACE_DAYS = "10";
    process.env.EXECUTION_RETENTION_BATCH_SIZE = "250";
    process.env.EXECUTION_RETENTION_MAX_RUNTIME_SECONDS = "30";

    expect(getRetentionConfig()).toEqual({
      enabled: true,
      dryRun: true,
      defaultLogRetentionDays: 14,
      minLogRetentionDays: 3,
      lookbackDays: 2,
      executionLogFloorRetentionDays: 180,
      outputRawRetentionDays: 5,
      executionRetentionDays: 500,
      softDeleteGraceDays: 10,
      batchSize: 250,
      maxRuntimeMs: 30_000,
    });
  });

  it('accepts "1" as well as "true" for the switches', () => {
    process.env.EXECUTION_RETENTION_ENABLED = "1";
    process.env.EXECUTION_RETENTION_DRY_RUN = "1";

    const config = getRetentionConfig();

    expect(config.enabled).toBe(true);
    expect(config.dryRun).toBe(true);
  });

  it.each(["0", "-5", "not-a-number", ""])(
    "falls back to the default rather than to 0 for %o",
    (value) => {
      process.env.EXECUTION_RETENTION_DAYS = value;

      // A 0 window would mean "delete everything", which is the one outcome a
      // typo must never produce.
      expect(getRetentionConfig().executionRetentionDays).toBe(400);
    }
  );

  it("raises the default window to the floor when the floor is higher", () => {
    process.env.EXECUTION_RETENTION_MIN_DAYS = "30";
    process.env.EXECUTION_RETENTION_DEFAULT_DAYS = "7";

    expect(getRetentionConfig().defaultLogRetentionDays).toBe(30);
  });
});

describe("daysBefore", () => {
  it("subtracts whole days", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");

    expect(daysBefore(now, 7).toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });
});

describe("resolveRetentionDays", () => {
  const config = getRetentionConfig();

  it.each([
    ["free", 7],
    ["pro", 30],
    ["business", 90],
    ["enterprise", 365],
  ])("gives %s the window its plan sells: %i days", (plan, expected) => {
    expect(
      resolveRetentionDays({ plan, tier: null, planOverrides: null }, config)
    ).toBe(expected);
  });

  it("uses the default for an organization with no subscription row", () => {
    expect(
      resolveRetentionDays(
        { plan: null, tier: null, planOverrides: null },
        config
      )
    ).toBe(config.defaultLogRetentionDays);
  });

  it("lets a per-org override win, which is how a custom contract gets its window", () => {
    expect(
      resolveRetentionDays(
        { plan: "pro", tier: "25k", planOverrides: { logRetentionDays: 730 } },
        config
      )
    ).toBe(730);
  });

  it("clamps an override below the floor instead of deleting fresh data", () => {
    expect(
      resolveRetentionDays(
        {
          plan: "enterprise",
          tier: null,
          planOverrides: { logRetentionDays: 1 },
        },
        config
      )
    ).toBe(config.minLogRetentionDays);
  });

  it("treats an unrecognized plan as free, matching getOrgPlan", () => {
    expect(
      resolveRetentionDays(
        { plan: "platinum", tier: null, planOverrides: null },
        config
      )
    ).toBe(7);
  });

  it("falls back to the default when an override is not a usable number", () => {
    expect(
      resolveRetentionDays(
        {
          plan: "pro",
          tier: null,
          planOverrides: { logRetentionDays: Number.NaN },
        },
        config
      )
    ).toBe(config.defaultLogRetentionDays);
  });
});

describe("groupByRetentionWindow", () => {
  const config = getRetentionConfig();

  it("collapses organizations that share a window and orders shortest first", () => {
    const groups = groupByRetentionWindow(
      new Map([
        ["org-a", 7],
        ["org-b", 30],
        ["org-c", 7],
      ]),
      config
    );

    expect(groups).toEqual([
      { retentionDays: 7, organizationIds: ["org-a", "org-c"] },
      { retentionDays: 30, organizationIds: ["org-b"] },
    ]);
  });

  it("drops organizations already covered by the floor pass", () => {
    // Enterprise at 365 days is under the 400-day floor, so it still needs the
    // join; an org whose override reaches the floor does not.
    const groups = groupByRetentionWindow(
      new Map([
        ["enterprise-org", 365],
        ["floor-org", config.executionLogFloorRetentionDays],
        ["above-floor-org", config.executionLogFloorRetentionDays + 100],
      ]),
      config
    );

    expect(groups).toEqual([
      { retentionDays: 365, organizationIds: ["enterprise-org"] },
    ]);
  });

  it("returns nothing when every organization is at the floor", () => {
    expect(groupByRetentionWindow(new Map([["org-a", 400]]), config)).toEqual(
      []
    );
  });
});
