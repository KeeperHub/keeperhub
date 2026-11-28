/** The Analytics Skipped and Not landed tooltips share one billing wording. */
import { describe, expect, it } from "vitest";
import { SKIPPED_TOOLTIP } from "@/components/analytics/kpi-cards";
import { STATUS_TOOLTIPS } from "@/components/analytics/runs-table";
import { SKIPPED_BILLING_TEXT } from "@/lib/workflow/waiting-run-groups";

describe("Analytics billing tooltips", () => {
  it("the KPI Skipped tooltip and the Skipped badge both carry the skipped billing line", () => {
    expect(SKIPPED_TOOLTIP).toContain(SKIPPED_BILLING_TEXT);
    expect(STATUS_TOOLTIPS.skipped).toContain(SKIPPED_BILLING_TEXT);
    expect(SKIPPED_BILLING_TEXT).toContain(
      "and so does a waiting run with a step off the read-only list."
    );
  });

  it("the Not landed badge counts toward your plan's runs", () => {
    expect(STATUS_TOOLTIPS.not_landed).toContain("your plan's runs");
    expect(STATUS_TOOLTIPS.not_landed).not.toContain("usage");
  });
});
