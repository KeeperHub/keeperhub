import { describe, expect, it } from "vitest";
import { PAYG_BLOCK_MESSAGES } from "@/lib/billing/payg/errors";
import {
  refusalFixHref,
  refusalFixLink,
  refusalHalted,
  refusalStaysOff,
  shownRefusal,
} from "@/lib/notifications/failure-alerts/view-types";
import {
  NOT_EXECUTABLE_REASONS,
  notExecutableRefusal,
  SCHEDULE_INVALID_REFUSAL,
  STATE_REFUSAL_PATTERN,
  WORKFLOW_NOT_FOUND_REFUSAL,
} from "@/lib/workflow/not-executable";

const stateRefusal = new RegExp(STATE_REFUSAL_PATTERN);

describe("refusal texts", () => {
  it("every code but anonymous_owner stops counting once its state ends", () => {
    for (const reason of NOT_EXECUTABLE_REASONS) {
      expect(stateRefusal.test(notExecutableRefusal(reason))).toBe(
        reason !== "anonymous_owner"
      );
    }
    expect(stateRefusal.test(SCHEDULE_INVALID_REFUSAL)).toBe(true);
    expect(stateRefusal.test("Monthly execution limit reached")).toBe(false);
  });

  it("shows every code in plain words", () => {
    for (const reason of NOT_EXECUTABLE_REASONS) {
      expect(shownRefusal(notExecutableRefusal(reason))).not.toContain(
        `(${reason})`
      );
    }
    expect(refusalHalted(notExecutableRefusal("halted"))).toBe(true);
    expect(refusalStaysOff(notExecutableRefusal("org_deactivated"))).toBe(true);
  });
});

describe("refusalFixLink", () => {
  it("has no link when the workflow cannot run, stored or shown", () => {
    for (const reason of NOT_EXECUTABLE_REASONS) {
      const stored = notExecutableRefusal(reason);
      expect(refusalFixLink(stored)).toBeNull();
      expect(refusalFixLink(shownRefusal(stored))).toBeNull();
    }
    expect(refusalFixLink(SCHEDULE_INVALID_REFUSAL)).toBeNull();
    expect(refusalFixLink(WORKFLOW_NOT_FOUND_REFUSAL)).toBeNull();
  });

  it("sends pay-as-you-go to Billing and the rest to Plans", () => {
    expect(refusalFixLink(PAYG_BLOCK_MESSAGES.payment_failed)).toEqual({
      page: "billing",
      label: "Open Billing",
    });
    const plans = refusalFixLink("Monthly execution limit reached");
    expect(plans).toEqual({ page: "plans", label: "Open Plans" });
    expect(plans && refusalFixHref("org 1", plans)).toBe(
      "/settings/org%201/plans"
    );
  });
});
