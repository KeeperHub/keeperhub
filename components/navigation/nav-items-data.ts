/**
 * Single source of truth for the navigation destinations.
 *
 * The desktop sidebar (navigation-sidebar.tsx) and the mobile navigation sheet
 * (mobile-nav-items.ts) both render from this list, so a destination added
 * here appears on both surfaces or fails the parity tests. Icons are NOT part
 * of this module: they are presentation, resolved per surface (the sidebar
 * maps id -> Lucide icon; the mobile sheet does the same). Keeping icons out
 * lets tests import this module without pulling the React/lucide runtime.
 */
export type NavItemId =
  | "hub"
  | "workflows"
  | "analytics"
  | "earnings"
  | "held-payments"
  | "address-book"
  | "activity"
  | "settings";

export type NavItemData = {
  id: NavItemId;
  label: string;
  /** Desktop route. null means the desktop sidebar treats it as an action
   *  item (flyout/overlay) rather than a page link. */
  href: string | null;
  /** Route on mobile when it differs from desktop. Workflows is a flyout on
   *  desktop (null href) but routes to its list page on mobile. */
  mobileHref?: string;
  requireAuth: boolean;
  // Visible only to organization owners/admins (the audit feed is gated the
  // same way server-side).
  adminOnly?: boolean;
  // Visible only to organization owners (fund-moving surfaces like held
  // payments; enforced server-side too).
  ownerOnly?: boolean;
  /** Desktop sidebar action items: workflows and address-book open flyouts,
   *  activity is a page but has special click handling. */
  actionItem?: boolean;
};

export const NAV_ITEMS_DATA: NavItemData[] = [
  { id: "hub", label: "Hub", href: "/hub", requireAuth: false },
  {
    id: "workflows",
    label: "Workflows",
    href: null,
    mobileHref: "/workflows",
    requireAuth: false,
    actionItem: true,
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
  {
    id: "address-book",
    label: "Address Book",
    href: null,
    requireAuth: true,
    actionItem: true,
  },
  {
    // Visible to everyone and routable while signed-out: the page itself shows
    // an in-page sign-in for guests, a labelled sample for members, and the
    // real feed for owners/admins. So this is neither requireAuth nor adminOnly.
    id: "activity",
    label: "Activity",
    href: "/activity",
    requireAuth: false,
    actionItem: true,
  },
];

// Settings is a destination, not a workspace view, so it sits at the foot of
// the desktop nav column rather than among Hub / Workflows / Analytics. It is
// a normal routable destination on mobile. Its href is non-null (unlike the
// flyout entries above), which the mobile derivation relies on.
export const SETTINGS_NAV_ITEM_DATA: NavItemData & { href: string } = {
  id: "settings",
  label: "Settings",
  href: "/settings",
  requireAuth: true,
};

/** Desktop items whose click opens a flyout or has special handling. */
export const ACTION_ITEM_IDS: ReadonlySet<string> = new Set(
  NAV_ITEMS_DATA.filter((item) => item.actionItem).map((item) => item.id)
);
