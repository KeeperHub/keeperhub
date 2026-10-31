import {
  Activity,
  BarChart3,
  Bookmark,
  Clock,
  DollarSign,
  Globe,
  Info,
  Settings,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { useAuthPrompt } from "@/components/auth/provider";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { startNewWorkflow } from "@/lib/workflow/start-new-workflow";

// The navigation's items, what picking one does and New Workflow, shared by
// the sidebar and the phone drawer.

export type NavItemDef = {
  id: string;
  icon: typeof Globe;
  label: string;
  href: string | null;
  requireAuth: boolean;
  // Visible only to organization owners/admins (the audit feed is gated the
  // same way server-side).
  adminOnly?: boolean;
  // Visible only to organization owners (fund-moving surfaces like held
  // payments; enforced server-side too).
  ownerOnly?: boolean;
};

const NAV_ITEMS: NavItemDef[] = [
  {
    id: "hub",
    icon: Globe,
    label: "Hub",
    href: "/hub",
    requireAuth: false,
  },
  {
    id: "workflows",
    icon: WorkflowIcon,
    label: "Workflows",
    href: null,
    requireAuth: false,
  },
  {
    id: "analytics",
    icon: BarChart3,
    label: "Analytics",
    href: "/analytics",
    requireAuth: true,
  },
  {
    id: "earnings",
    icon: DollarSign,
    label: "Earnings",
    href: "/earnings",
    requireAuth: true,
  },
  {
    id: "held-payments",
    icon: Clock,
    label: "Held Payments",
    href: "/held-payments",
    requireAuth: true,
    ownerOnly: true,
  },
  {
    id: "address-book",
    icon: Bookmark,
    label: "Address Book",
    href: null,
    requireAuth: true,
  },
  {
    // Visible to everyone and routable while signed-out: the page itself shows
    // an in-page sign-in for guests, a labelled sample for members, and the
    // real feed for owners/admins. So this is neither requireAuth nor adminOnly.
    id: "activity",
    icon: Activity,
    label: "Activity",
    href: "/activity",
    requireAuth: false,
  },
];

// Settings is a destination, not a workspace view, so it sits at the foot of
// the nav column rather than among Hub / Workflows / Analytics -- above the
// divider that starts the external links, but pushed clear of Activity.
export const SETTINGS_NAV_ITEM: NavItemDef = {
  id: "settings",
  icon: Settings,
  label: "Settings",
  href: "/settings",
  requireAuth: true,
};

// Which nav item is "you are here", by route alone; the flyout state is not.
export function isNavItemActive(id: string, pathname: string): boolean {
  if (id === "workflows") {
    return pathname === "/workflows" || pathname.startsWith("/workflows/");
  }
  if (id === "settings") {
    return pathname === "/settings" || pathname.startsWith("/settings/");
  }
  const href = NAV_ITEMS.find((item) => item.id === id)?.href;
  return href !== null && href !== undefined && pathname === href;
}

// The nav items a member sees: admin-only and owner-only ones by role.
export function visibleNavItems(
  isAdmin: boolean,
  isOwner: boolean
): NavItemDef[] {
  return NAV_ITEMS.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.ownerOnly || isOwner)
  );
}

type NavItemHandlers = {
  isAnonymous: boolean;
  openAuthPrompt: ReturnType<typeof useAuthPrompt>["openAuthPrompt"];
  openWorkflows: () => void;
  openAddressBook: () => void;
  push: (href: string) => void;
};

// What picking a nav item does, in the sidebar and in the phone drawer. Only
// Workflows differs between them, so each passes its own.
export function followNavItem(
  item: NavItemDef,
  handlers: NavItemHandlers
): void {
  // NAV-02: requireAuth items click-gate to the shared auth modal instead
  // of routing to a 401 page when the user is signed-out or anonymous.
  if (item.requireAuth && handlers.isAnonymous) {
    handlers.openAuthPrompt({
      action: `nav:${item.id}`,
      redirectTo: item.href ?? undefined,
    });
    return;
  }
  if (item.id === "workflows") {
    handlers.openWorkflows();
    return;
  }
  if (item.id === "address-book") {
    handlers.openAddressBook();
    return;
  }
  if (item.href) {
    handlers.push(item.href);
  }
}

// New Workflow's look, in the sidebar and in the phone drawer.
export const NEW_WORKFLOW_LOOK =
  "items-center gap-1.5 whitespace-nowrap rounded-md border border-keeperhub-green/20 bg-keeperhub-green/10 font-medium text-keeperhub-green text-sm hover:border-keeperhub-green/40 hover:bg-keeperhub-green/15";

// The external links at the foot of the nav.
export const FOOTER_LINKS = [
  {
    icon: DiscordIcon,
    label: "Join Discord",
    href: "https://discord.gg/keeperhub",
  },
  {
    icon: Info,
    label: "Documentation",
    href: "https://docs.keeperhub.com",
  },
] as const;

// What to tell an anonymous visitor sent to their one workflow (`created`
// false), so the click is not silently a no-op.
const ANONYMOUS_WORKFLOW_CAP_MESSAGE = "Sign in to create more workflows.";
// What to say when New Workflow fails, before going home.
const NEW_WORKFLOW_FAILED_MESSAGE = "Failed to create workflow";

/**
 * New Workflow, in the sidebar and in the phone drawer: makes a workflow and
 * hands it to `onCreated`. An anonymous visitor who already has their one
 * workflow is told why and sent to it; a workflow that could not be made is
 * reported (and logged) and the user sent home. `onSettled` runs once the
 * workflow is made or not, before anything navigates.
 */
export async function runNewWorkflow({
  isAnonymous,
  hasSession,
  push,
  onSettled,
  onCreated,
}: {
  isAnonymous: boolean;
  hasSession: boolean;
  push: (href: string) => void;
  onSettled?: () => void;
  onCreated: (workflowId: string) => Promise<void> | void;
}): Promise<void> {
  let started: Awaited<ReturnType<typeof startNewWorkflow>>;
  try {
    started = await startNewWorkflow({ isAnonymous, hasSession });
  } catch (error) {
    onSettled?.();
    console.error("[New Workflow] Could not create a workflow", error);
    toast.error(NEW_WORKFLOW_FAILED_MESSAGE);
    push("/");
    return;
  }
  onSettled?.();
  if (!started.created) {
    toast.info(ANONYMOUS_WORKFLOW_CAP_MESSAGE);
    push(`/workflows/${started.id}`);
    return;
  }
  await onCreated(started.id);
}
