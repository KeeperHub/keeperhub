"use client";

import {
  Activity,
  BarChart3,
  Clock,
  DollarSign,
  Globe,
  Menu,
  Settings,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthPrompt } from "@/components/auth/provider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { cn } from "@/lib/utils";

type MobileNavItem = {
  id: string;
  icon: typeof Globe;
  label: string;
  href: string;
  requireAuth: boolean;
  ownerOnly?: boolean;
  adminOnly?: boolean;
};

// The read-only monitoring + account destinations. "Workflows" and
// "Address Book" are flyout/overlay actions in the desktop sidebar (they
// open panels, not pages) and have no equivalent as a bare link, so they
// are intentionally not here — the workflow you are monitoring is reachable
// via its run history and the list via /workflows.
const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { id: "hub", icon: Globe, label: "Hub", href: "/hub", requireAuth: false },
  {
    id: "workflows",
    icon: WorkflowIcon,
    label: "Workflows",
    href: "/workflows",
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
    id: "activity",
    icon: Activity,
    label: "Activity",
    href: "/activity",
    requireAuth: false,
  },
  {
    id: "settings",
    icon: Settings,
    label: "Settings",
    href: "/settings",
    requireAuth: true,
  },
];

export function MobileNavSheet(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { data: session } = useSession();
  const { openAuthPrompt } = useAuthPrompt();
  const { isAdmin, isOwner } = useActiveMember();

  if (!isMobile) {
    return null;
  }

  const isActive = (href: string): boolean =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  const visible = MOBILE_NAV_ITEMS.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.ownerOnly || isOwner)
  );

  const handleNavigate = (item: MobileNavItem): void => {
    setOpen(false);
    if (item.requireAuth && (!session?.user || isAnonymousUser(session.user))) {
      openAuthPrompt({ action: `nav:${item.id}`, redirectTo: item.href });
      return;
    }
    router.push(item.href);
  };

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>
        <button
          aria-label="Open navigation"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="mobile-nav-trigger"
          type="button"
        >
          <Menu className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent className="w-72 gap-1 p-0" side="left">
        <SheetHeader className="border-b px-4 py-3 text-left">
          <SheetTitle className="text-sm font-semibold">Navigate</SheetTitle>
          <SheetDescription className="sr-only">
            KeeperHub sections
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile navigation" className="flex flex-col gap-1 p-2">
          {visible.map((item) => {
            const active = isActive(item.href);
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted",
                  active && "bg-muted font-medium"
                )}
                data-testid={`mobile-nav-${item.id}`}
                key={item.id}
                onClick={() => handleNavigate(item)}
                type="button"
              >
                <item.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
