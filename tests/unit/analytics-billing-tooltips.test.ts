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

  it("a Running badge says a run can be a transaction sent and not mined yet", () => {
    expect(STATUS_TOOLTIPS.running).toContain(
      "a transaction was sent and is not mined yet"
    );
  });

  it("the Running badge says a mined copy is paid for; Not landed names a dropped copy's causes", () => {
    expect(STATUS_TOOLTIPS.running).toContain(
      "If it is mined, the wallet pays its gas, even if it reverts."
    );
    expect(STATUS_TOOLTIPS.not_landed).toContain(
      "A public copy that no RPC knows any more ends Not landed too: most often its fee cap was below the base fee, or an RPC rejected it, so raise Max Fee or leave it empty, and check the wallet's balance."
    );
  });

  it("the Skipped tooltips name a skip behind an earlier run's public copy", () => {
    for (const text of [SKIPPED_TOOLTIP, STATUS_TOOLTIPS.skipped]) {
      expect(text).toContain("an earlier run's public copy not mined yet");
    }
  });
});
