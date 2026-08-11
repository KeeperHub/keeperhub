/**
 * Unit test for ScanDisclaimer copy — HARDEN-04.
 *
 * Verifies that SUGGESTION_DISCLAIMER contains the reviewed financial-advice
 * disclaimer copy (including the KeeperHub brand attribution sentence) that
 * legal/product signed off before the funnel goes live on staging.
 *
 * The reviewed copy (pinned here for cross-file agreement with 55-03):
 *   "This is not financial advice. KeeperHub does not provide financial
 *    advice. Automations act on live on-chain data; always verify your
 *    positions and thresholds before enabling a workflow."
 *
 * Wave 0: This test is RED. The current SUGGESTION_DISCLAIMER lacks the
 * "KeeperHub does not provide financial advice" sentence. It turns GREEN in
 * 55-03 when the reviewed copy is applied.
 *
 * Note: The vitest environment is node (no jsdom). The constant is tested
 * directly — the component renders it verbatim, so a copy match on the
 * constant is equivalent to a DOM text match on <ScanDisclaimer />.
 */
import { describe, expect, it } from "vitest";
import { SUGGESTION_DISCLAIMER } from "@/lib/scan/suggestions/types";

describe("ScanDisclaimer: reviewed copy (HARDEN-04)", () => {
  it("contains financial advice disclaimer with KeeperHub brand attribution", () => {
    expect(SUGGESTION_DISCLAIMER).toContain("not financial advice");
    // RED: this sentence is absent from the current copy; added by 55-03
    expect(SUGGESTION_DISCLAIMER).toContain(
      "KeeperHub does not provide financial advice"
    );
  });
});
