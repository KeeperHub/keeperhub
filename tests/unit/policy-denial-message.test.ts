import { describe, expect, it } from "vitest";
import { PolicyDecisionReason } from "@/lib/policy";
import {
  explainDenial,
  isPolicyDenialMessage,
  POLICY_DENIAL_MESSAGE,
  policyPageLink,
} from "@/lib/policy/errors";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";

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

  it("carries the address of the rules that refused it", () => {
    // A run is read in the app, an execution log, an agent's reply or a CLI
    // transcript. The message has to carry where to go, because most of those
    // have nowhere else to put it.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(message).toMatch(/https?:\/\/\S+\/settings\/[^/]+\/policies/);
  });

  it("survives the redaction that strips a web3 step's URLs", () => {
    // That rule exists so a provider host cannot reach a user. Our own address
    // is the opposite: it is where we are sending them, and replacing it with a
    // placeholder took away the one useful thing the message had.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(redactAllUrls(message)).toBe(message);
  });

  it("still redacts a provider URL beside it", () => {
    expect(
      redactAllUrls("failed at https://eth-mainnet.g.alchemy.com/v2/SECRET")
    ).not.toContain("alchemy");
  });

  it("carries the reason and the link, and nothing else", () => {
    for (const reason of Object.values(PolicyDecisionReason)) {
      expect(explainDenial({ reason, organizationId: ORG })).toBe(
        `${POLICY_DENIAL_MESSAGE[reason]} Review your organization's policies at ${policyPageLink(
          { organizationId: ORG }
        )}`
      );
    }
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
