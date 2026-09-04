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
import {
  NAV_ITEMS_DATA,
  SETTINGS_NAV_ITEM_DATA,
} from "@/components/navigation/nav-items-data";

const OWNER = { isAdmin: true, isOwner: true };
const ADMIN = { isAdmin: true, isOwner: false };
const MEMBER = { isAdmin: false, isOwner: false };

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

  // Parity with the desktop sidebar. Both surfaces derive from the same
  // NAV_ITEMS_DATA (nav-items-data.ts), so these tests assert the derivation
  // rule itself against the real source rather than a hand-copied list: a
  // destination added to NAV_ITEMS_DATA with a routable surface appears on
  // mobile, and one without (desktop-only flyout) does not.
  it("covers every desktop destination that has a routable surface", () => {
    const desktopRoutable = NAV_ITEMS_DATA.filter(
      (item) => item.href !== null || item.mobileHref !== undefined
    );
    for (const item of desktopRoutable) {
      expect(
        MOBILE_NAV_ITEMS.find((i) => i.id === item.id),
        `mobile nav is missing the desktop destination "${item.id}"`
      ).toBeDefined();
    }
    // Settings is a separate shared entry appended to both surfaces.
    expect(
      MOBILE_NAV_ITEMS.find((i) => i.id === SETTINGS_NAV_ITEM_DATA.id)
    ).toBeDefined();
  });

  it("derives mobile auth gating from the shared source, not a copy", () => {
    const expected: Record<string, boolean> = {};
    for (const item of NAV_ITEMS_DATA) {
      expected[item.id] = item.requireAuth;
    }
    expected[SETTINGS_NAV_ITEM_DATA.id] = SETTINGS_NAV_ITEM_DATA.requireAuth;
    for (const item of MOBILE_NAV_ITEMS) {
      expect(
        expected[item.id],
        `no shared-source entry known for mobile item "${item.id}"`
      ).toBeDefined();
      expect(
        item.requireAuth,
        `${item.id} requireAuth diverges from the shared source`
      ).toBe(expected[item.id]);
    }
  });

  it("keeps owner-only gating aligned with the shared source", () => {
    const ownerOnlyIds: string[] = NAV_ITEMS_DATA.filter(
      (item) => item.ownerOnly
    ).map((item) => item.id);
    for (const item of MOBILE_NAV_ITEMS) {
      expect(item.ownerOnly === true).toBe(ownerOnlyIds.includes(item.id));
    }
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
      expect(decideMobileNavAction(item, signedIn)).toEqual({
        kind: "route",
      });
    }
  });

  it("signed-out user is auth-prompted on requireAuth destinations", () => {
    const analytics = itemById("analytics");
    const hub = itemById("hub");
    expect(decideMobileNavAction(analytics, signedOut)).toEqual({
      kind: "auth-prompt",
    });
    expect(decideMobileNavAction(hub, signedOut)).toEqual({
      kind: "route",
    });
  });

  it("anonymous user is treated like signed-out on requireAuth destinations", () => {
    const analytics = itemById("analytics");
    expect(decideMobileNavAction(analytics, anonymous)).toEqual({
      kind: "auth-prompt",
    });
  });
});
