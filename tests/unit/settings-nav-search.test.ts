import { describe, expect, it } from "vitest";
import {
  findSettingsItem,
  findSettingsMatches,
  isSettingsItemVisible,
  type SettingsNavItem,
} from "@/components/settings/hub/nav";

const OWNER = { isAdmin: true, isOwner: true };
const MEMBER = { isAdmin: false, isOwner: false };

/** Every card the query surfaced, as "Section > Card". */
function results(query: string, access = OWNER): string[] {
  return findSettingsMatches(query, access).flatMap((match) =>
    match.panels.map((panel) => `${match.item.label} > ${panel.title}`)
  );
}

describe("findSettingsMatches", () => {
  it("finds both the personal and the org side of a term", () => {
    expect(results("mfa")).toEqual([
      "Account security > Two-factor authentication",
      "Organization security > Organization MFA enforcement",
    ]);
  });

  it("matches a card by any of its other names", () => {
    for (const query of ["2fa", "totp", "authenticator", "backup codes"]) {
      expect(results(query)).toContain(
        "Account security > Two-factor authentication"
      );
    }
  });

  it("ignores the punctuation in a card's title", () => {
    expect(results("two factor")).toContain(
      "Account security > Two-factor authentication"
    );
  });

  it("matches whole words, so pin does not reach grouping", () => {
    expect(results("pin")).toEqual(["Account security > Wallet step-up"]);
  });

  it("lists everything in a section when the section itself is named", () => {
    expect(results("billing")).toEqual([
      "Billing > This month",
      "Billing > Payment and invoices",
      "Billing > Pay as you go",
    ]);
  });

  it("leaves out sections the member cannot open", () => {
    expect(results("daily value caps", MEMBER)).toEqual([]);
    expect(results("daily value caps")).toEqual([
      "Spending limits > Daily value caps",
    ]);
  });

  it("offers billing and plans to a member", () => {
    expect(results("plans", MEMBER)).toEqual([]);
    expect(
      findSettingsMatches("plans", MEMBER).map((m) => m.item.segment)
    ).toEqual(["plans"]);
    expect(results("gas sponsorship credits", MEMBER)).toEqual([
      "Billing > This month",
    ]);
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(results("  ")).toEqual([]);
    expect(results("zzzz")).toEqual([]);
  });
});

describe("isSettingsItemVisible", () => {
  const item = (pathname: string): SettingsNavItem => {
    const found = findSettingsItem(pathname);
    if (!found) {
      throw new Error(`no settings item for ${pathname}`);
    }
    return found;
  };

  it("opens billing and plans to every member of the organization", () => {
    expect(isSettingsItemVisible(item("/settings/org-1/billing"), MEMBER)).toBe(
      true
    );
    expect(isSettingsItemVisible(item("/settings/org-1/plans"), MEMBER)).toBe(
      true
    );
  });

  it("keeps the admin sections closed to a member", () => {
    for (const segment of ["security", "notifications", "limits"]) {
      expect(
        isSettingsItemVisible(item(`/settings/org-1/${segment}`), MEMBER)
      ).toBe(false);
      expect(
        isSettingsItemVisible(item(`/settings/org-1/${segment}`), OWNER)
      ).toBe(true);
    }
  });

  it("tells the account security page from the organization one", () => {
    expect(item("/settings/security").scope).toBe("user");
    expect(isSettingsItemVisible(item("/settings/security"), MEMBER)).toBe(
      true
    );
  });
});
