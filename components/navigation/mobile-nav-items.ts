import type { LucideIcon } from "lucide-react";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { NAV_ITEMS_DATA, SETTINGS_NAV_ITEM_DATA } from "./nav-items-data";

export type MobileNavItem = {
  id: string;
  /** Presentation-only — resolved to a Lucide icon by the component. Kept off
   *  the data module so tests import zero React/lucide runtime. */
  icon?: LucideIcon;
  label: string;
  href: string;
  requireAuth: boolean;
  ownerOnly?: boolean;
  adminOnly?: boolean;
};

// The mobile nav derives from the same NAV_ITEMS_DATA the desktop sidebar
// renders, so a destination added to that one list either appears on both
// surfaces or fails the parity tests. Derivation rule: an item appears on
// mobile when it has a routable surface there - a desktop page (href) or a
// mobile route (mobileHref, used where desktop treats the item as a flyout
// with a null href). Items with neither (address-book) are desktop-only
// flyouts and stay off mobile. Settings is a destination on both surfaces and
// is appended from its own shared entry, matching its separate position at
// the foot of the desktop nav.
export const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  ...NAV_ITEMS_DATA.flatMap((item) => {
    const href = item.href ?? item.mobileHref;
    if (!href) {
      // Desktop-only flyout (address-book): no routable surface on mobile.
      return [];
    }
    return [
      {
        id: item.id,
        label: item.label,
        href,
        requireAuth: item.requireAuth,
        ownerOnly: item.ownerOnly,
        adminOnly: item.adminOnly,
      },
    ];
  }),
  {
    id: SETTINGS_NAV_ITEM_DATA.id,
    label: SETTINGS_NAV_ITEM_DATA.label,
    href: SETTINGS_NAV_ITEM_DATA.href,
    requireAuth: SETTINGS_NAV_ITEM_DATA.requireAuth,
  },
];

export type NavAccess = {
  isAdmin: boolean;
  isOwner: boolean;
};

/** The nav items a caller with this access level may see. */
export function visibleMobileNavItems(
  access: NavAccess,
  items: MobileNavItem[] = MOBILE_NAV_ITEMS
): MobileNavItem[] {
  return items.filter(
    (item) =>
      (!item.adminOnly || access.isAdmin) && (!item.ownerOnly || access.isOwner)
  );
}

/** Whether a route is the active one for a nav destination. */
export function isMobileNavActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type NavDecision = { kind: "route" } | { kind: "auth-prompt" };

export type SessionUser = {
  name?: string | null;
  email?: string | null;
};

/**
 * What tapping a nav item does: signed-out/anonymous users on a requireAuth
 * destination are sent to the auth prompt; everyone else routes.
 * `sessionUser` is the session's user object (may be null when signed out).
 */
export function decideMobileNavAction(
  item: MobileNavItem,
  sessionUser: SessionUser | null | undefined
): NavDecision {
  if (item.requireAuth && isAnonymousUser(sessionUser)) {
    return { kind: "auth-prompt" };
  }
  return { kind: "route" };
}
