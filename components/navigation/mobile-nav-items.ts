import type { LucideIcon } from "lucide-react";
import { isAnonymousUser } from "@/lib/is-anonymous";

export type MobileNavItem = {
  id: string;
  /** Presentation-only — resolved to a Lucide icon by the component. Kept off
   *  the data module so tests import zero React/lucide runtime. */
  icon?: LucideIcon;
  label: string;
  href: string;
  requireAuth: boolean;
  ownerOnly?: boolean;
};

// The read-only monitoring + account destinations. "Workflows" and
// "Address Book" are flyout/overlay actions in the desktop sidebar (they
// open panels, not pages) and have no equivalent as a bare link, so they
// are intentionally not here — the workflow you are monitoring is reachable
// via its run history and the list via /workflows.
//
// Source-of-truth note: the desktop sidebar (components/navigation-sidebar.tsx)
// keeps its own NAV_ITEMS because it renders flyouts (null hrefs) that have no
// mobile equivalent, and because its NavItemDef carries a Lucide icon — the
// mobile module deliberately keeps icons out so tests import zero React
// runtime. The two lists intentionally diverge only where desktop has a
// flyout/overlay where mobile routes to the underlying page (workflows) or has
// no page at all (address-book). The parity test below asserts the invariants
// that must hold for the shared page destinations.
export const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { id: "hub", label: "Hub", href: "/hub", requireAuth: false },
  {
    id: "workflows",
    label: "Workflows",
    href: "/workflows",
    requireAuth: false,
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/analytics",
    requireAuth: true,
  },
  { id: "earnings", label: "Earnings", href: "/earnings", requireAuth: true },
  {
    id: "held-payments",
    label: "Held Payments",
    href: "/held-payments",
    requireAuth: true,
    ownerOnly: true,
  },
  { id: "activity", label: "Activity", href: "/activity", requireAuth: false },
  { id: "settings", label: "Settings", href: "/settings", requireAuth: true },
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
    (item) => !item.ownerOnly || access.isOwner
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
