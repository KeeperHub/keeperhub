/**
 * KEEP-1042: the rules that decide how long execution data lives. Pure
 * functions only -- config parsing and its clamps, the per-organization window,
 * and the schedule that decides which pass owns which organizations. The
 * database side is covered by tests/integration/retention-route.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { daysBefore, getRetentionConfig } from "@/lib/retention/config";
import {
  buildRetentionSchedule,
  resolveRetentionDays,
} from "@/lib/retention/org-windows";

const RETENTION_ENV_KEYS = [
  "EXECUTION_RETENTION_ENABLED",
  "EXECUTION_RETENTION_EXECUTIONS_ENABLED",
  "EXECUTION_RETENTION_DRY_RUN",
  "EXECUTION_RETENTION_DEFAULT_DAYS",
  "EXECUTION_RETENTION_MIN_DAYS",
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
  it("is off by default, and run-row deletion has a second switch of its own", () => {
    const config = getRetentionConfig();

    expect(config.enabled).toBe(false);
    expect(config.executionsEnabled).toBe(false);
  });

  it("carries the documented defaults", () => {
    expect(getRetentionConfig()).toMatchObject({
      dryRun: false,
      defaultLogRetentionDays: 7,
      minLogRetentionDays: 7,
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
    process.env.EXECUTION_RETENTION_EXECUTIONS_ENABLED = "true";
    process.env.EXECUTION_RETENTION_DRY_RUN = "true";
    process.env.EXECUTION_RETENTION_MIN_DAYS = "3";
    process.env.EXECUTION_RETENTION_DEFAULT_DAYS = "14";
    process.env.EXECUTION_LOG_FLOOR_RETENTION_DAYS = "180";
    process.env.EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS = "5";
    process.env.EXECUTION_RETENTION_DAYS = "500";
    process.env.EXECUTION_RETENTION_SOFT_DELETE_GRACE_DAYS = "10";
    process.env.EXECUTION_RETENTION_BATCH_SIZE = "250";
    process.env.EXECUTION_RETENTION_MAX_RUNTIME_SECONDS = "30";

    expect(getRetentionConfig()).toEqual({
      enabled: true,
      executionsEnabled: true,
      dryRun: true,
      defaultLogRetentionDays: 14,
      minLogRetentionDays: 3,
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
      process.env.EXECUTION_RETENTION_SOFT_DELETE_GRACE_DAYS = value;

      // A 0 window would mean "delete everything", which is the one outcome a
      // typo must never produce.
      expect(getRetentionConfig().softDeleteGraceDays).toBe(30);
    }
  );

  it.each([
    ["EXECUTION_RETENTION_DEFAULT_DAYS", "defaultLogRetentionDays"],
    ["EXECUTION_LOG_FLOOR_RETENTION_DAYS", "executionLogFloorRetentionDays"],
    ["EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS", "outputRawRetentionDays"],
  ] as const)("raises %s to the configured floor", (envKey, field) => {
    process.env.EXECUTION_RETENTION_MIN_DAYS = "30";
    process.env[envKey] = "1";

    expect(getRetentionConfig()[field]).toBe(30);
  });

  it("will not let the run-row window be shortened below its hard floor", () => {
    // Everything that reads workflow_executions for billing has no date floor
    // of its own, so a short value here moves live quotas and rewrites past
    // invoices in a single run. The variable can lengthen the window only; the
    // way to stop the pass is its switch.
    process.env.EXECUTION_RETENTION_DAYS = "30";

    expect(getRetentionConfig().executionRetentionDays).toBe(400);
  });

  it("still lets the run-row window be lengthened", () => {
    process.env.EXECUTION_RETENTION_DAYS = "800";

    expect(getRetentionConfig().executionRetentionDays).toBe(800);
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
    // 975 of 1409 prod organizations are in this state, so the fallback is the
    // common case rather than the edge one. It matches getOrgPlan, which also
    // reads a missing row as the free plan.
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

describe("buildRetentionSchedule", () => {
  const config = getRetentionConfig();

  it("gives the no-join pass the longest window in use", () => {
    // Not the configured ceiling: the organizations on the longest window hold
    // most of the table, and the floor pass is the only one that can reach them
    // without a three-table join.
    const schedule = buildRetentionSchedule(
      new Map([
        ["free-org", 7],
        ["pro-org", 30],
        ["enterprise-org", 365],
      ]),
      config
    );

    expect(schedule.floorDays).toBe(365);
    expect(schedule.groups).toEqual([
      { retentionDays: 7, organizationIds: ["free-org"] },
      { retentionDays: 30, organizationIds: ["pro-org"] },
    ]);
  });

  it("collapses organizations that share a window and orders shortest first", () => {
    const schedule = buildRetentionSchedule(
      new Map([
        ["org-a", 7],
        ["org-b", 30],
        ["org-c", 7],
        ["org-long", 365],
      ]),
      config
    );

    expect(schedule.groups).toEqual([
      { retentionDays: 7, organizationIds: ["org-a", "org-c"] },
      { retentionDays: 30, organizationIds: ["org-b"] },
    ]);
  });

  it("caps the floor at the configured ceiling and drops what reaches it", () => {
    // An override asking for more than the ceiling does not get it: the ceiling
    // is the absolute limit, and the floor pass enforces it.
    const schedule = buildRetentionSchedule(
      new Map([
        ["org-a", 30],
        ["override-org", 730],
      ]),
      config
    );

    expect(schedule.floorDays).toBe(config.executionLogFloorRetentionDays);
    expect(schedule.groups).toEqual([
      { retentionDays: 30, organizationIds: ["org-a"] },
    ]);
  });

  it("leaves no per-organization work when every window is the same", () => {
    const schedule = buildRetentionSchedule(
      new Map([
        ["org-a", 7],
        ["org-b", 7],
      ]),
      config
    );

    expect(schedule.floorDays).toBe(7);
    expect(schedule.groups).toEqual([]);
  });
});
