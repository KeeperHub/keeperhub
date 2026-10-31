"use client";

import { ChevronRight, Loader2, Menu, Plus } from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAuthPrompt } from "@/components/auth/provider";
import {
  type DrawerView,
  LEVEL_TITLE_ATTR,
  MobileNavWorkflows,
} from "@/components/mobile-nav-workflows";
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
import { usePickerData } from "@/components/workflow-picker-data";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePressGrace } from "@/hooks/use-press-grace";
import { useSession } from "@/lib/auth-client";
import { isEscapeHandled, markEscapeHandled } from "@/lib/escape-key";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { cn } from "@/lib/utils";
import { getCustomLogo } from "@/lib/workflow/editor/extension-registry";

const MENU_VIEW: DrawerView = { level: "menu" };

// What takes focus once a level has drawn, found inside the drawer.
type FocusTarget = (drawer: Element) => HTMLElement | null | undefined;

const levelTitle: FocusTarget = (drawer) =>
  drawer.querySelector<HTMLElement>(`[${LEVEL_TITLE_ATTR}]`);

// Taps pressed before a level was shown, or this soon after, are dropped: a
// double tap's second press would land on whatever the new level put there.
const LEVEL_TAP_GRACE_MS = 350;

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
  // Which level the drawer shows (the menu, Workflows or a project), and
  // what takes focus once it has drawn.
  const [nav, setNav] = useState<{
    view: DrawerView;
    focus: FocusTarget | null;
  }>({ view: MENU_VIEW, focus: null });
  const view = nav.view;
  const drawerRef = useRef<HTMLDivElement>(null);
  // Restarted by a level change (not the reset on open) or its list loading,
  // and again at the frame that paints it: a busy phone paints late.
  const grace = usePressGrace(LEVEL_TAP_GRACE_MS);
  const startGrace = grace.start;
  const markLevelShown = useCallback((): void => {
    startGrace();
    requestAnimationFrame(startGrace);
  }, [startGrace]);

  useLayoutEffect(() => {
    if (nav.focus) {
      markLevelShown();
    }
  }, [nav, markLevelShown]);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (nav.focus && drawer) {
      (nav.focus(drawer) ?? levelTitle(drawer))?.focus();
    }
  }, [nav]);

  const goTo = useCallback((next: DrawerView, focus: FocusTarget): void => {
    setNav({ view: next, focus });
  }, []);

  // Up one level, focusing the row that opened the one left.
  const back = useCallback((): void => {
    if (view.level === "project") {
      const { projectId } = view;
      goTo({ level: "workflows" }, (drawer) =>
        [...drawer.querySelectorAll<HTMLElement>("[data-project-id]")].find(
          (row) => row.dataset.projectId === projectId
        )
      );
    } else if (view.level === "workflows") {
      goTo(MENU_VIEW, (drawer) =>
        drawer.querySelector<HTMLElement>('[data-nav-item="workflows"]')
      );
    }
  }, [view, goTo]);

  // Widening past 768px brings the sidebar back; the button is hidden then.
  useEffect(() => {
    if (!isMobile) {
      skipFocusReturn.current = true;
      setOpen(false);
    }
  }, [isMobile]);

  const close = useCallback((returnFocus = false): void => {
    skipFocusReturn.current = !returnFocus;
    setOpen(false);
  }, []);

  return (
    <Sheet
      onOpenChange={(next) => {
        if (next) {
          skipFocusReturn.current = false;
          setNav({ view: MENU_VIEW, focus: null });
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
        // Escape goes up a level (the drawer closes from the menu), after
        // any control inside that uses it, such as a filter menu.
        onEscapeKeyDown={(event) => {
          if (view.level !== "menu") {
            event.preventDefault();
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            view.level !== "menu" &&
            !isEscapeHandled(event.nativeEvent)
          ) {
            markEscapeHandled(event.nativeEvent);
            back();
          }
        }}
        ref={drawerRef}
        side="left"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        {/* Scrolls on a short screen; taps just after a level change are
            dropped. */}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          onClickCapture={grace.onClickCapture}
          onPointerDownCapture={grace.onPointerDownCapture}
        >
          <MobileNavBody
            creating={creating}
            goTo={goTo}
            onBack={back}
            onLevelListShown={markLevelShown}
            onPick={close}
            setCreating={setCreating}
            view={view}
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
  view,
  goTo,
  onBack,
  onLevelListShown,
}: {
  creating: boolean;
  setCreating: (creating: boolean) => void;
  onPick: (returnFocus?: boolean) => void;
  view: DrawerView;
  goTo: (next: DrawerView, focus: FocusTarget) => void;
  onBack: () => void;
  onLevelListShown: () => void;
}): React.ReactNode {
  const { data: session, isPending } = useSession();
  const { openAuthPrompt } = useAuthPrompt();
  const { open: openOverlay } = useOverlay();
  const { isAdmin, isOwner } = useActiveMember();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const { workflows, projects } = usePickerData();
  const isAnonymous = isAnonymousUser(session?.user);
  // A loading session looks anonymous (New Workflow would sign in
  // anonymously), and a pick while creating would race its navigation.
  const busy = isPending || creating;
  const CustomLogo = getCustomLogo();

  const items = visibleNavItems(isAdmin, isOwner);
  const activeWorkflowId =
    typeof params.workflowId === "string" ? params.workflowId : undefined;
  const activeProjectId = workflows.find(
    (w) => w.id === activeWorkflowId
  )?.projectId;
  const activeProject = projects.find((p) => p.id === activeProjectId);
  // Members get the Workflows level; a guest's list is never loaded (as in
  // the sidebar), so a guest goes to their workflow as before.
  const workflowsOpensLevel = Boolean(session?.user) && !isAnonymous;
  // The open workflow opens nothing new, so focus returns.
  const openWorkflow = useCallback(
    (id: string): void => onPick(id === activeWorkflowId),
    [onPick, activeWorkflowId]
  );

  const openProject = useCallback(
    (projectId: string): void =>
      goTo({ level: "project", projectId }, levelTitle),
    [goTo]
  );

  // Workflows opens on the open workflow's project, if it is in one.
  function openWorkflowsLevel(): void {
    goTo(
      activeProject
        ? { level: "project", projectId: activeProject.id }
        : { level: "workflows" },
      levelTitle
    );
  }

  if (view.level !== "menu") {
    return (
      <MobileNavWorkflows
        activeProjectId={activeProject?.id ?? null}
        activeWorkflowId={activeWorkflowId}
        isAnonymous={isAnonymous}
        onBack={onBack}
        onListShown={onLevelListShown}
        onOpenWorkflow={openWorkflow}
        onSelectProject={openProject}
        view={view}
      />
    );
  }

  function pick(item: NavItemDef): void {
    if (item.id === "workflows" && workflowsOpensLevel) {
      openWorkflowsLevel();
      return;
    }
    // Nothing opens for the page already shown, so focus returns (unless
    // an account-only item asks to sign in). Workflows (a guest's; members
    // got its level above) and Settings count only on their index: from a
    // workflow it goes to the latest one, from a settings section back to
    // the settings menu.
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
      // A guest opens their last-edited workflow (the /workflows index
      // redirects); signed-out visitors sign in first, then land there.
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
            label={
              item.id === "workflows" && workflowsOpensLevel
                ? [item.label, activeProject?.name, "opens a list"]
                    .filter(Boolean)
                    .join(", ")
                : undefined
            }
            onClick={() => pick(item)}
            trailing={
              item.id === "workflows" && workflowsOpensLevel ? (
                <span className="ml-auto flex min-w-0 items-center gap-1 pl-2 text-muted-foreground text-xs">
                  {activeProject ? (
                    <span className="truncate">{activeProject.name}</span>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0" />
                </span>
              ) : null
            }
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
  trailing,
  label,
}: {
  item: NavItemDef;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  // Shown at the row's end, such as the chevron of an item opening a level.
  trailing?: React.ReactNode;
  // The accessible name, when the row says more than its label.
  label?: string;
}): React.ReactNode {
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={cn(
        "flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60",
        active && "bg-muted"
      )}
      data-nav-item={item.id}
      data-testid={`mobile-nav-${item.id}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <item.icon className="size-4 shrink-0" />
      {/* With something at the end, that gives way first. */}
      <span className={cn("truncate", trailing && "shrink-0")}>
        {item.label}
      </span>
      {trailing}
    </button>
  );
}
