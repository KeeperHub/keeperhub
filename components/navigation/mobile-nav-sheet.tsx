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
import {
  decideMobileNavAction,
  isMobileNavActive,
  type MobileNavItem,
  visibleMobileNavItems,
} from "./mobile-nav-items";

const ICONS: Record<string, typeof Globe> = {
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
  const { isAdmin, isOwner } = useActiveMember();

  if (!isMobile) {
    return null;
  }

  const visible = visibleMobileNavItems({ isAdmin, isOwner });

  const handleNavigate = (item: MobileNavItem): void => {
    setOpen(false);
    const user = session?.user ?? null;
    if (
      decideMobileNavAction(item, user, isAnonymousUser).kind === "auth-prompt"
    ) {
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
            const Icon = ICONS[item.id] ?? Globe;
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
