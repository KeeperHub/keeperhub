// House style: this codebase does not depend on @testing-library/react, so the
// MobileNavSheet's pure decision logic (visible items, active state, tap
// action) is tested via the helper module rather than a DOM render — the same
// pattern settings-nav-search.test.ts uses.

import { describe, expect, it } from "vitest";

import {
  decideMobileNavAction,
  isMobileNavActive,
  MOBILE_NAV_ITEMS,
  type MobileNavItem,
  visibleMobileNavItems,
} from "@/components/navigation/mobile-nav-items";

const OWNER = { isAdmin: true, isOwner: true };
const ADMIN = { isAdmin: true, isOwner: false };
const MEMBER = { isAdmin: false, isOwner: false };

// Mirrors the real lib/is-anonymous semantics: null/undefined or an
// Anonymous/temp-* user is anonymous.
const isAnonymous = (
  u: { name?: string | null; email?: string | null } | null | undefined
): boolean => {
  if (!u) {
    return true;
  }
  return (
    u.name === "Anonymous" ||
    Boolean(u.email?.includes("@http://")) ||
    Boolean(u.email?.includes("@https://")) ||
    Boolean(u.email?.startsWith("temp-"))
  );
};

function ids(items: MobileNavItem[]): string[] {
  return items.map((i) => i.id);
}

describe("visibleMobileNavItems", () => {
  it("a member sees the monitoring + account destinations but not owner-only ones", () => {
    const visible = visibleMobileNavItems(MEMBER);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "hub" }),
        expect.objectContaining({ id: "workflows" }),
        expect.objectContaining({ id: "analytics" }),
        expect.objectContaining({ id: "earnings" }),
        expect.objectContaining({ id: "activity" }),
        expect.objectContaining({ id: "settings" }),
      ])
    );
    expect(ids(visible)).not.toContain("held-payments");
  });

  it("an owner additionally sees owner-only destinations", () => {
    expect(ids(visibleMobileNavItems(OWNER))).toContain("held-payments");
  });

  it("an admin (non-owner) does not see owner-only destinations", () => {
    expect(ids(visibleMobileNavItems(ADMIN))).not.toContain("held-payments");
  });

  it("every visible item has a routable href (no flyout/overlay-only entries leak)", () => {
    for (const item of visibleMobileNavItems(MEMBER)) {
      expect(item.href.startsWith("/")).toBe(true);
    }
  });

  it("the mobile set excludes the desktop flyout/overlay-only actions", () => {
    // Address Book is an overlay on desktop and has no page to route to on
    // mobile; it must not appear as a dead link.
    expect(ids(MOBILE_NAV_ITEMS)).not.toContain("address-book");
  });
});

describe("isMobileNavActive", () => {
  it("marks the exact route active", () => {
    expect(isMobileNavActive("/analytics", "/analytics")).toBe(true);
  });

  it("marks a subroute of a section active", () => {
    expect(isMobileNavActive("/workflows", "/workflows/abc123")).toBe(true);
    expect(isMobileNavActive("/settings", "/settings/org-1/organization")).toBe(
      true
    );
  });

  it("does not mark a sibling route active", () => {
    expect(isMobileNavActive("/analytics", "/earnings")).toBe(false);
    expect(isMobileNavActive("/workflows", "/workflow-other")).toBe(false);
  });

  it("root href matches only the exact root", () => {
    expect(isMobileNavActive("/", "/")).toBe(true);
    expect(isMobileNavActive("/", "/analytics")).toBe(false);
  });
});

describe("decideMobileNavAction", () => {
  const signedIn = { name: "Ada", email: "ada@keeperhub.com" };
  const signedOut: { name?: string | null; email?: string | null } | null =
    null;
  const anonymous = { name: "Anonymous", email: "temp-abc@keeperhub.com" };

  function itemById(id: string): MobileNavItem {
    const found = MOBILE_NAV_ITEMS.find((i) => i.id === id);
    if (!found) {
      throw new Error(`no mobile nav item with id ${id}`);
    }
    return found;
  }

  it("signed-in user routes everywhere", () => {
    for (const item of MOBILE_NAV_ITEMS) {
      expect(decideMobileNavAction(item, signedIn, isAnonymous)).toEqual({
        kind: "route",
      });
    }
  });

  it("signed-out user is auth-prompted on requireAuth destinations", () => {
    const analytics = itemById("analytics");
    const hub = itemById("hub");
    expect(decideMobileNavAction(analytics, signedOut, isAnonymous)).toEqual({
      kind: "auth-prompt",
    });
    expect(decideMobileNavAction(hub, signedOut, isAnonymous)).toEqual({
      kind: "route",
    });
  });

  it("anonymous user is treated like signed-out on requireAuth destinations", () => {
    const analytics = itemById("analytics");
    expect(decideMobileNavAction(analytics, anonymous, isAnonymous)).toEqual({
      kind: "auth-prompt",
    });
  });
});
