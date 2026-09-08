import { describe, expect, it } from "vitest";

import { isConsentOrgMismatch } from "@/app/oauth/authorize/_lib/consent-binding";

describe("isConsentOrgMismatch (F-022 / KEEP-747)", () => {
  it("is false when the consented org matches the org resolved at submit time", () => {
    expect(isConsentOrgMismatch("org_acme", "org_acme")).toBe(false);
  });

  it("is true when the active org changed between render and approve", () => {
    // User saw + consented to org_acme but switched to org_personal in another
    // tab before clicking Approve.
    expect(isConsentOrgMismatch("org_acme", "org_personal")).toBe(true);
  });

  it("is false when no org was bound (backward-compatible older form)", () => {
    expect(isConsentOrgMismatch(null, "org_acme")).toBe(false);
    expect(isConsentOrgMismatch(undefined, "org_acme")).toBe(false);
    expect(isConsentOrgMismatch("", "org_acme")).toBe(false);
  });
});
