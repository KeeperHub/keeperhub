"use client";

import { Loader2, Menu, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuthPrompt } from "@/components/auth/provider";
import {
  FOOTER_LINKS,
  followNavItem,
  isNavItemActive,
  type NavItemDef,
  NEW_WORKFLOW_LOOK,
  runNewWorkflow,
  SETTINGS_NAV_ITEM,
  visibleNavItems,
} from "@/components/nav-items";
import { OrgSwitcher } from "@/components/organization/org-switcher";
import { AddressBookOverlay } from "@/components/overlays/address-book-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { cn } from "@/lib/utils";
import { getCustomLogo } from "@/lib/workflow/editor/extension-registry";

// Items that open their index from anywhere inside their section, so they
// count as already shown only there.
const INDEX_PATHS: Partial<Record<string, string>> = {
  workflows: "/workflows",
  settings: "/settings",
};

/**
 * The navigation on a phone: below 768px, where the sidebar is not drawn,
 * this header button opens the sidebar's items in a drawer from the left.
 * Its contents mount only while open, so a closed drawer fetches nothing.
 */
export function MobileNav({
  triggerRef,
}: {
  // The menu button, for the header's org switcher to hand focus to where
  // it is hidden.
  triggerRef?: React.Ref<HTMLButtonElement>;
} = {}): React.ReactNode {
  const [open, setOpen] = useState(false);
  // Here rather than in the contents, which unmount on close, so reopening
  // mid-create cannot start a second workflow.
  const [creating, setCreating] = useState(false);
  const isMobile = useIsMobile();
  // True when the drawer closes for a pick that opens something elsewhere,
  // so focus is not pulled back to this button. Cleared on every open (the
  // drawer opens only through this button).
  const skipFocusReturn = useRef(false);

  // Widening past 768px brings the sidebar back; the button is hidden then.
  useEffect(() => {
    if (!isMobile) {
      skipFocusReturn.current = true;
      setOpen(false);
    }
  }, [isMobile]);

  function close(returnFocus = false): void {
    skipFocusReturn.current = !returnFocus;
    setOpen(false);
  }

  return (
    <Sheet
      onOpenChange={(next) => {
        if (next) {
          skipFocusReturn.current = false;
        }
        setOpen(next);
      }}
      open={open}
    >
      <SheetTrigger asChild>
        <Button
          aria-label="Open navigation"
          className="md:hidden"
          data-testid="mobile-nav-trigger"
          ref={triggerRef}
          size="icon"
          variant="ghost"
        >
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        aria-describedby={undefined}
        // Drawer timings 300ms in, 200ms out (the motion spec's
        // --duration-slower and --duration-slow, which the app's CSS does
        // not load), none with reduced motion.
        className="w-72 max-w-5/6 gap-0 p-0 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none"
        // A 44px target in the logo row.
        closeClassName="top-0.5 right-1 flex size-11 items-center justify-center rounded-md"
        data-testid="mobile-nav"
        onCloseAutoFocus={(event) => {
          if (skipFocusReturn.current) {
            event.preventDefault();
          }
        }}
        side="left"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        {/* Scrolls on a short screen; the close button stays above it. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <MobileNavBody
            creating={creating}
            onPick={close}
            setCreating={setCreating}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MobileNavBody({
  creating,
  setCreating,
  onPick,
}: {
  creating: boolean;
  setCreating: (creating: boolean) => void;
  onPick: (returnFocus?: boolean) => void;
}): React.ReactNode {
  const { data: session, isPending } = useSession();
  const { openAuthPrompt } = useAuthPrompt();
  const { open: openOverlay } = useOverlay();
  const { isAdmin, isOwner, isViewer } = useActiveMember();
  const router = useRouter();
  const pathname = usePathname();
  const isAnonymous = isAnonymousUser(session?.user);
  // A loading session looks anonymous (New Workflow would sign in
  // anonymously), and a pick while creating would race its navigation.
  const busy = isPending || creating;
  const CustomLogo = getCustomLogo();

  const items = visibleNavItems(isAdmin, isOwner);

  function pick(item: NavItemDef): void {
    // Nothing opens for the page already shown, so focus returns (unless
    // an account-only item asks to sign in). Workflows and Settings count
    // only on their index: from a workflow it goes to the latest one, and
    // from a settings section back to the settings menu.
    const index = INDEX_PATHS[item.id];
    const alreadyShown = index
      ? pathname === index
      : isNavItemActive(item.id, pathname);
    if (alreadyShown && !(item.requireAuth && isAnonymous)) {
      onPick(true);
      return;
    }
    onPick();
    followNavItem(item, {
      isAnonymous,
      openAuthPrompt,
      // No room for the sidebar's workflow list: open the last-edited
      // workflow (the /workflows index redirects), which needs a session.
      openWorkflows: () => {
        if (session?.user) {
          router.push("/workflows?latest=edited");
        } else {
          openAuthPrompt({
            action: "nav:workflows",
            redirectTo: "/workflows?latest=edited",
          });
        }
      },
      openAddressBook: () => openOverlay(AddressBookOverlay),
      push: (href) => router.push(href),
    });
  }

  async function newWorkflow(): Promise<void> {
    setCreating(true);
    // onSettled runs whether or not the workflow was made.
    await runNewWorkflow({
      isAnonymous,
      hasSession: Boolean(session),
      push: (href) => router.push(href),
      onSettled: () => {
        setCreating(false);
        onPick();
      },
      onCreated: (workflowId) => {
        refetchSidebar({ workflowCreated: true });
        router.push(`/workflows/${workflowId}`);
      },
    });
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        {CustomLogo ? <CustomLogo className="size-7 shrink-0" /> : null}
      </div>
      {/* Below xs the header has no room for the org switcher, so it is
          here instead (the header's hides below xs). */}
      {isAnonymous ? null : (
        <div className="shrink-0 border-b px-2.5 py-2.5 xs:hidden">
          <p className="px-0.5 pb-1.5 text-muted-foreground text-xs">
            Organization
          </p>
          <OrgSwitcher menu={{ disabled: busy, onPick }} />
        </div>
      )}
      {!isViewer && (
        <div className="flex shrink-0 items-center border-b px-2.5 py-2.5">
          <button
            className={cn(
              NEW_WORKFLOW_LOOK,
              "flex h-11 w-full justify-center px-3 transition-colors disabled:opacity-60"
            )}
            data-testid="mobile-nav-new"
            disabled={busy}
            onClick={() => {
              // A workflow that could not be made is reported in
              // runNewWorkflow; anything after that is only logged.
              newWorkflow().catch((error: unknown) => {
                console.error("[MobileNav] New Workflow", error);
              });
            }}
            type="button"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            <span>New Workflow</span>
          </button>
        </div>
      )}
      <nav
        aria-label="Main navigation"
        className="flex flex-1 flex-col gap-1 px-2.5 py-3"
      >
        {items.map((item) => (
          <MobileNavItem
            active={isNavItemActive(item.id, pathname)}
            disabled={busy}
            item={item}
            key={item.id}
            onClick={() => pick(item)}
          />
        ))}
        <div className="mt-auto pt-2">
          <MobileNavItem
            active={isNavItemActive(SETTINGS_NAV_ITEM.id, pathname)}
            disabled={busy}
            item={SETTINGS_NAV_ITEM}
            onClick={() => pick(SETTINGS_NAV_ITEM)}
          />
        </div>
      </nav>
      <div className="flex shrink-0 flex-col gap-1 border-t px-2.5 py-3">
        {FOOTER_LINKS.map((link) => (
          <a
            className="flex h-11 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-muted"
            href={link.href}
            key={link.label}
            // A new tab opens nothing here, so focus returns.
            onClick={() => onPick(true)}
            rel="noopener"
            target="_blank"
          >
            <link.icon className="size-4 shrink-0" />
            <span className="truncate">{link.label}</span>
          </a>
        ))}
      </div>
    </>
  );
}

function MobileNavItem({
  item,
  active,
  disabled,
  onClick,
}: {
  item: NavItemDef;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.ReactNode {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60",
        active && "bg-muted"
      )}
      data-testid={`mobile-nav-${item.id}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}
