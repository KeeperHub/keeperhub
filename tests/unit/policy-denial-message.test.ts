import { describe, expect, it } from "vitest";
import { PolicyDecisionReason } from "@/lib/policy";
import {
  explainDenial,
  isPolicyDenialMessage,
  POLICY_DENIAL_MESSAGE,
  policyPageLink,
} from "@/lib/policy/errors";

const ORG = "85a32c46-a6b5-401c-9d88-598cf573e042";

describe("what a blocked run tells the reader", () => {
  it("says why it was refused", () => {
    expect(
      explainDenial({
        reason: PolicyDecisionReason.LIMIT_EXCEEDED,
        organizationId: ORG,
      })
    ).toContain("no remaining allowance");
  });

  it("puts no URL in the message", () => {
    // The same string is written to a step, a log line and an API response, and
    // one of those paths strips every URL from a web3 step's error, because a
    // URL there is normally an RPC endpoint. Embedding one left the reader with
    // a redaction placeholder where the help should have been.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(message).not.toMatch(/https?:\/\//);
  });

  it("carries the reason and nothing else", () => {
    // Pinning the whole string is what stops a rule name, a condition or an
    // amount being appended later.
    for (const reason of Object.values(PolicyDecisionReason)) {
      expect(explainDenial({ reason, organizationId: ORG })).toBe(
        POLICY_DENIAL_MESSAGE[reason]
      );
    }
  });

  it("still builds an absolute link for a surface that can render one", () => {
    // Where to go did not disappear, it moved to the caller, which can show it
    // as something clickable rather than a sentence.
    expect(policyPageLink({ organizationId: ORG })).toMatch(
      /https?:\/\/\S+\/settings\/[^/]+\/policies/
    );
  });

  it("recognises its own refusals, so a caller can offer the way back", () => {
    for (const reason of Object.values(PolicyDecisionReason)) {
      expect(isPolicyDenialMessage(POLICY_DENIAL_MESSAGE[reason])).toBe(true);
    }
    expect(isPolicyDenialMessage("execution reverted")).toBe(false);
    expect(isPolicyDenialMessage(null)).toBe(false);
  });

  it("never names the rule that decided", () => {
    // Reading policy is limited to admins and owners, and any member can run a
    // workflow. A statement name is author-written and routinely carries the
    // thing it bounds, so naming it would disclose the rule to someone not
    // allowed to read it.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(message).not.toContain("Rule:");
    expect(message).not.toContain("sid");
  });

  it("omits the link when the organization is unknown", () => {
    expect(explainDenial({ reason: PolicyDecisionReason.ENGINE_ERROR })).toBe(
      POLICY_DENIAL_MESSAGE[PolicyDecisionReason.ENGINE_ERROR]
    );
  });

  it("points at the policy page without naming one", () => {
    // A bare organization link, so the URL itself reveals nothing either.
    expect(policyPageLink({ organizationId: ORG })).toMatch(
      new RegExp(`/settings/${ORG}/policies$`)
    );
  });
});
