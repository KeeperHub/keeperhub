/** The Analytics Skipped and Not landed tooltips share one billing wording. */
import { describe, expect, it } from "vitest";
import { SKIPPED_TOOLTIP } from "@/components/analytics/kpi-cards";
import { STATUS_TOOLTIPS } from "@/components/analytics/runs-table";
import { SKIPPED_BILLING_TEXT } from "@/lib/errors/execution-status";

describe("Analytics billing tooltips", () => {
  it("the KPI Skipped tooltip and the Skipped badge both carry the skipped billing line", () => {
    expect(SKIPPED_TOOLTIP).toContain(SKIPPED_BILLING_TEXT);
    expect(STATUS_TOOLTIPS.skipped).toContain(SKIPPED_BILLING_TEXT);
    expect(SKIPPED_BILLING_TEXT).toBe(
      "Skipped runs do not count toward your plan's runs, except waiting runs and runs skipped because an earlier run's bundle (or public copy) was in flight."
    );
    // One "Skipped runs do not count" opening, not two in a row.
    expect(SKIPPED_TOOLTIP).toContain(
      `They do not count toward your success rate. ${SKIPPED_BILLING_TEXT}`
    );
    expect(SKIPPED_TOOLTIP.split("Skipped runs do not count")).toHaveLength(2);
    for (const text of [SKIPPED_TOOLTIP, STATUS_TOOLTIPS.skipped]) {
      expect(text).not.toContain("read-only list");
      expect(text).not.toContain("refunded");
    }
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
    // A running run may have no public copy, so its tooltip names no fee cap cause.
    expect(STATUS_TOOLTIPS.running).not.toContain("fee cap");
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
