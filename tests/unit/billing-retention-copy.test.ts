/**
 * The wording a customer sees before a shorter step-log window applies. The
 * purge deletes step logs past the plan window and a lapsed plan falls to the
 * free window, so the plan-change dialog and the billing status have to say it
 * - and must stay silent when nothing is lost.
 */

import { describe, expect, it } from "vitest";
import { PLANS } from "@/lib/billing/plans";
import {
  formatLogRetention,
  RETENTION_AFTER_PLAN_ENDS_DAYS,
  retentionAfterPlanEndsNotice,
  retentionDowngradeWarning,
} from "@/lib/billing/retention-copy";

describe("retentionDowngradeWarning", () => {
  it("warns when the new plan keeps step logs for less time", () => {
    expect(retentionDowngradeWarning(30, 7)).toBe(
      "Step logs older than 7 days will be deleted after this change."
    );
  });

  it("names a year rather than 365 days", () => {
    expect(retentionDowngradeWarning(730, 365)).toBe(
      "Step logs older than 1 year will be deleted after this change."
    );
  });

  it.each([
    [7, 30],
    [30, 30],
  ])(
    "stays silent on an upgrade or an equal window (%i -> %i)",
    (current, next) => {
      expect(retentionDowngradeWarning(current, next)).toBeNull();
    }
  );

  it("warns on every real downgrade between the published plans", () => {
    const pro = PLANS.pro.features.logRetentionDays;
    const free = PLANS.free.features.logRetentionDays;
    expect(retentionDowngradeWarning(pro, free)).not.toBeNull();
  });
});

describe("retentionAfterPlanEndsNotice", () => {
  it("uses the free plan's window, which is where a lapsed plan lands", () => {
    expect(RETENTION_AFTER_PLAN_ENDS_DAYS).toBe(
      PLANS.free.features.logRetentionDays
    );
    expect(retentionAfterPlanEndsNotice()).toBe(
      `step logs older than ${formatLogRetention(PLANS.free.features.logRetentionDays)} are deleted`
    );
  });
});

describe("formatLogRetention", () => {
  it("formats windows the way the plan-change dialog shows them", () => {
    expect(formatLogRetention(7)).toBe("7 days");
    expect(formatLogRetention(90)).toBe("90 days");
    expect(formatLogRetention(365)).toBe("1 year");
  });
});
