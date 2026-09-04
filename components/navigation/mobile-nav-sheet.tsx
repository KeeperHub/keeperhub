"use client";

import type { LucideIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  decideMobileNavAction,
  isMobileNavActive,
  type MobileNavItem,
  visibleMobileNavItems,
} from "./mobile-nav-items";
import type { NavItemId } from "./nav-items-data";

// Exhaustive over the mobile-reachable destinations (all NavItemId except the
// desktop-only address-book flyout, which never appears on mobile). Keyed by
// the shared union so a destination added to NAV_ITEMS_DATA without an icon is
// a compile error here, not a silent Globe at runtime.
const ICONS: Record<Exclude<NavItemId, "address-book">, LucideIcon> = {
  hub: Globe,
  workflows: WorkflowIcon,
  analytics: BarChart3,
  earnings: DollarSign,
  "held-payments": Clock,
  activity: Activity,
  settings: Settings,
};

export function MobileNavSheet(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { data: session } = useSession();
  const { openAuthPrompt } = useAuthPrompt();
  const { isAdmin, isOwner, isLoading: memberLoading } = useActiveMember();

  if (!isMobile) {
    return null;
  }

  // While the active-org membership is still loading, isOwner is false, which
  // would make an owner-only destination (Held Payments) pop in after the fact.
  // Render the non-owner set during the load; the owner set appears in the
  // next render once the member record resolves. The only item that can appear
  // later is one the user is entitled to see, so nothing flashes wrongly.
  const visible = memberLoading
    ? visibleMobileNavItems({ isAdmin: false, isOwner: false })
    : visibleMobileNavItems({ isAdmin, isOwner });

  const handleNavigate = (item: MobileNavItem): void => {
    setOpen(false);
    const user = session?.user ?? null;
    if (decideMobileNavAction(item, user).kind === "auth-prompt") {
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
            const active = isMobileNavActive(item.href, pathname);
            const Icon = ICONS[item.id as keyof typeof ICONS] ?? Globe;
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
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
