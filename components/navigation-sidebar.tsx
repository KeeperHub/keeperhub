"use client";

import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthPrompt } from "@/components/auth/provider";
import { GettingStartedLauncher } from "@/components/onboarding/getting-started-launcher";
import { AddressBookOverlay } from "@/components/overlays/address-book-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSession } from "@/lib/auth-client";
import { isEscapeFromOverlay, isEscapeHandled } from "@/lib/escape-key";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { NavPanelStates } from "@/lib/hooks/use-persisted-nav-state";
import { usePersistedNavState } from "@/lib/hooks/use-persisted-nav-state";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { registerSidebarRefetch } from "@/lib/refetch-sidebar";
import { cn } from "@/lib/utils";
import { FLYOUT_WIDTH, FlyoutPanel, STRIP_WIDTH } from "./flyout-panel";
import {
  FOOTER_LINKS,
  followNavItem,
  isNavItemActive,
  type NavItemDef,
  NEW_WORKFLOW_LOOK,
  runNewWorkflow,
  SETTINGS_NAV_ITEM,
  visibleNavItems,
} from "./nav-items";
import { usePickerData } from "./workflow-picker-data";
import { PickerFilterButton, usePickerFilter } from "./workflow-picker-filter";
import {
  ProjectWorkflowsList,
  WorkflowsRootList,
} from "./workflow-picker-panels";

export const COLLAPSED_WIDTH = 60;
export const EXPANDED_WIDTH = 200;
const SNAP_THRESHOLD = (COLLAPSED_WIDTH + EXPANDED_WIDTH) / 2;

// The rows of filter menus in the Workflows panel and in a project's panel.
const ROOT_FILTER_ROW_ID = "workflow-root-filter";
const PROJECT_FILTER_ROW_ID = "workflow-project-filter";

function computePanelOffsets(
  sidebarWidth: number,
  panels: NavPanelStates
): { projects: number; tags: number; workflows: number; rightEdge: number } {
  let offset = sidebarWidth;

  const projects = offset;
  if (panels.projects === "open") {
    offset += FLYOUT_WIDTH;
  } else if (panels.projects === "collapsed") {
    offset += STRIP_WIDTH;
  }

  const tags = offset;
  if (panels.tags === "open") {
    offset += FLYOUT_WIDTH;
  } else if (panels.tags === "collapsed") {
    offset += STRIP_WIDTH;
  }

  const workflows = offset;
  if (panels.workflows === "open") {
    offset += FLYOUT_WIDTH;
  } else if (panels.workflows === "collapsed") {
    offset += STRIP_WIDTH;
  }

  return { projects, tags, workflows, rightEdge: offset };
}

function SidebarHeader({
  expanded,
  onToggle,
  onNewWorkflow,
}: {
  expanded: boolean;
  onToggle: () => void;
  onNewWorkflow: () => void;
}): React.ReactNode {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center overflow-hidden border-b",
        expanded ? "px-3" : "relative justify-center pr-0.5"
      )}
    >
      <button
        aria-label="New Workflow"
        className={cn(
          expanded
            ? cn(
                NEW_WORKFLOW_LOOK,
                "group/new flex px-2 py-1 transition-all duration-200 hover:shadow-[0_0_8px_rgba(0,255,100,0.08)] active:scale-[0.97]"
              )
            : "z-20 flex items-center justify-center text-keeperhub-green transition-colors hover:text-keeperhub-green-dark"
        )}
        data-testid="nav-new"
        onClick={onNewWorkflow}
        type="button"
      >
        <Plus
          className={cn(
            expanded
              ? "size-3.5 transition-transform duration-150 group-hover/new:rotate-90"
              : "size-4"
          )}
        />
        {expanded && <span>New Workflow</span>}
      </button>
      <button
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        className={cn(
          "shrink-0 transition-colors",
          expanded
            ? "ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            : "absolute right-0.5 z-20 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
        onClick={onToggle}
        type="button"
      >
        {expanded ? (
          <ChevronLeft className="size-4" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
      </button>
    </div>
  );
}

const ACTION_ITEM_IDS: ReadonlySet<string> = new Set([
  "workflows",
  "address-book",
  "activity",
]);

function NavItem({
  item,
  active,
  showLabels,
  onClick,
}: {
  item: NavItemDef;
  active: boolean;
  showLabels: boolean;
  onClick: () => void;
}): React.ReactNode {
  const disabled = item.href === null && !ACTION_ITEM_IDS.has(item.id);
  const layoutClass = showLabels ? "gap-3 px-2" : "justify-center";

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={item.label}
            className={cn(
              "flex h-9 w-full cursor-default items-center rounded-md text-muted-foreground transition-colors",
              layoutClass
            )}
            data-testid={`nav-${item.id}`}
            type="button"
          >
            <item.icon className="size-4 shrink-0" />
            {showLabels && (
              <span className="truncate text-sm">{item.label}</span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Coming Soon</TooltipContent>
      </Tooltip>
    );
  }

  const button = (
    <button
      aria-label={item.label}
      className={cn(
        "flex h-9 w-full items-center rounded-md transition-colors hover:bg-muted",
        layoutClass,
        active && "bg-muted"
      )}
      data-testid={`nav-${item.id}`}
      onClick={onClick}
      type="button"
    >
      <item.icon className="size-4 shrink-0" />
      {showLabels && <span className="truncate text-sm">{item.label}</span>}
    </button>
  );

  if (showLabels) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

export function NavigationSidebar(): React.ReactNode {
  const isMobile = useIsMobile();
  const { data: session, isPending } = useSession();
  const { openAuthPrompt } = useAuthPrompt();
  const { open: openOverlay } = useOverlay();
  const { isAdmin, isOwner } = useActiveMember();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const navState = usePersistedNavState();

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const {
    byProject,
    ungrouped,
    projects,
    tags,
    loading: dataLoading,
    refetch,
  } = usePickerData();
  // Each panel filters its own list: the Workflows panel the workflows
  // outside any project, a project's panel that project's workflows.
  const rootFilter = usePickerFilter(navState.state.panels.projects);
  const projectFilter = usePickerFilter(navState.state.panels.tags);
  const isDragging = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const clearRootFilter = rootFilter.clear;
  const showAllRootWorkflows = rootFilter.showAll;
  const clearProjectFilter = projectFilter.clear;

  useEffect(
    () =>
      registerSidebarRefetch((options) => {
        if (options?.closeFlyout) {
          navState.closeAll();
        }
        // An org switch keeps the panels open; a filter belongs to the
        // workflows it was set on.
        if (options?.orgChanged) {
          clearRootFilter();
          clearProjectFilter();
        }
        if (options?.workflowCreated) {
          showAllRootWorkflows();
        }
      }),
    [
      navState.closeAll,
      clearRootFilter,
      clearProjectFilter,
      showAllRootWorkflows,
    ]
  );

  // Validate persisted selections after data loads
  useEffect(() => {
    if (!dataLoading) {
      navState.validateSelections(
        projects.map((p) => p.id),
        tags.map((t) => t.id)
      );
    }
  }, [dataLoading, navState.validateSelections, projects, tags]);

  const isAnonymous = isAnonymousUser(session?.user);

  const workflowId =
    typeof params.workflowId === "string" ? params.workflowId : undefined;
  const isSettingsPage = isNavItemActive(SETTINGS_NAV_ITEM.id, pathname);

  const expanded = navState.state.sidebar;
  const setExpanded = navState.setSidebar;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      setDragWidth(expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH);

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        if (!isDragging.current) {
          return;
        }
        const newWidth = Math.min(
          EXPANDED_WIDTH,
          Math.max(COLLAPSED_WIDTH, moveEvent.clientX)
        );
        setDragWidth(newWidth);
      };

      const handleMouseUp = (upEvent: MouseEvent): void => {
        isDragging.current = false;
        const finalX = Math.min(
          EXPANDED_WIDTH,
          Math.max(COLLAPSED_WIDTH, upEvent.clientX)
        );
        setExpanded(finalX >= SNAP_THRESHOLD);
        setDragWidth(null);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [expanded, setExpanded]
  );

  // Escape peels rightmost panel, click outside closes all
  const anyPanelOpen =
    navState.state.panels.projects !== "closed" ||
    navState.state.panels.tags !== "closed" ||
    navState.state.panels.workflows !== "closed";

  const anyPanelExpanded =
    navState.state.panels.projects === "open" ||
    navState.state.panels.tags === "open" ||
    navState.state.panels.workflows === "open";

  useEffect(() => {
    if (!anyPanelOpen) {
      return;
    }

    function handleKeyDown(e: KeyboardEvent): void {
      // A control that used this Escape itself (a filter menu closing, a
      // filter button hiding the row) tags it; that step is all it does.
      // Likewise an Escape that closes a dialog, menu or select.
      if (
        e.key === "Escape" &&
        !isEscapeHandled(e) &&
        !isEscapeFromOverlay(e)
      ) {
        navState.peelRightmost();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anyPanelOpen, navState.peelRightmost]);

  const currentWidth =
    dragWidth ?? (expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--nav-sidebar-width",
      `${currentWidth}px`
    );
    // Full left offset including any open/collapsed flyout panels, so pages
    // that resize their main frame (e.g. analytics) sit beside the panels
    // instead of being overlapped by them.
    const { rightEdge } = computePanelOffsets(
      currentWidth,
      navState.state.panels
    );
    document.documentElement.style.setProperty(
      "--nav-content-offset",
      `${rightEdge}px`
    );
  }, [currentWidth, navState.state.panels]);

  // The settings hub renders its own rail under the shared toolbar, so the
  // workflow sidebar would be a second, competing navigation there.
  if (isMobile || !navState.hasMounted || isSettingsPage) {
    return null;
  }

  // Derived data
  const selectedProjectId = navState.state.selectedProjectId;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const allProjectWorkflows = byProject[selectedProjectId ?? ""] ?? [];

  const showLabels = currentWidth >= SNAP_THRESHOLD;
  const offsets = computePanelOffsets(currentWidth, navState.state.panels);

  async function handleNewWorkflow(): Promise<void> {
    await runNewWorkflow({
      isAnonymous,
      hasSession: Boolean(session),
      push: (href) => router.push(href),
      onCreated: async (workflowId) => {
        // Same as refetchSidebar({ workflowCreated: true }), awaited so the
        // list holds the new workflow before the panel opens on it.
        showAllRootWorkflows();
        await refetch();
        navState.setPanelState("projects", "open");
        sessionStorage.setItem("animate-sidebar", "true");
        router.push(`/workflows/${workflowId}`);
      },
    });
  }

  function handleNavClick(item: NavItemDef): void {
    followNavItem(item, {
      isAnonymous,
      openAuthPrompt,
      openWorkflows: () => {
        if (navState.state.panels.projects === "closed") {
          navState.setPanelState("projects", "open");
        } else {
          navState.closeAll();
        }
      },
      openAddressBook: () => openOverlay(AddressBookOverlay),
      // Keep the workflows flyout open when moving between pages so the
      // picker stays available instead of collapsing on every navigation.
      push: (href) => router.push(href),
    });
  }

  function handleSelectProject(id: string): void {
    if (id === selectedProjectId) {
      // Re-clicking same project toggles tags panel
      if (navState.state.panels.tags === "closed") {
        navState.setSelectedProject(id);
        navState.setPanelState("tags", "open");
      } else {
        navState.setPanelState("tags", "closed");
      }
      return;
    }
    navState.setSelectedProject(id);
    navState.setSelectedTag(null);
    navState.setPanelState("tags", "open");
    navState.setPanelState("workflows", "closed");
    // A filter belongs to the project it was set in.
    clearProjectFilter();
  }

  // NAV-01: render every nav item for everyone (anonymous, signed-out, signed-in).
  // Click-gating for requireAuth items happens in handleNavClick. The exception
  // is adminOnly items (e.g. org Activity), hidden for non-owner/admin members.
  const navItems = visibleNavItems(isAdmin, isOwner);

  // NAV-03: branch on isPending FIRST. While the better-auth session resolves,
  // render a neutral skeleton with the same width as the fully-loaded sidebar
  // so server and client emit the same DOM (no React 19 hydration warning,
  // no flicker, no layout shift).
  if (isPending) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-[calc(60px+var(--app-banner-height,0px))] bottom-0 left-0 z-40 flex flex-col bg-background"
        style={{ width: currentWidth }}
      />
    );
  }

  return (
    <>
      <div
        className={cn(
          "pointer-events-auto fixed top-[calc(60px+var(--app-banner-height,0px))] bottom-0 left-0 z-40 flex flex-col bg-background",
          dragWidth === null && "transition-[width] duration-200 ease-out"
        )}
        ref={sidebarRef}
        style={{ width: currentWidth }}
      >
        <SidebarHeader
          expanded={expanded}
          onNewWorkflow={() => {
            handleNewWorkflow().catch((error: unknown) => {
              console.error("[Sidebar] New Workflow", error);
            });
          }}
          onToggle={() => setExpanded(!expanded)}
        />

        <nav
          aria-label="Main navigation"
          className="flex flex-1 flex-col gap-1 overflow-hidden px-2.5 pt-3"
          data-testid="navigation-sidebar"
        >
          {navItems.map((item) => (
            <NavItem
              active={isNavItemActive(item.id, pathname)}
              item={item}
              key={item.id}
              onClick={() => handleNavClick(item)}
              showLabels={showLabels}
            />
          ))}
          <div className="mt-auto pb-1">
            <NavItem
              active={isSettingsPage}
              item={SETTINGS_NAV_ITEM}
              onClick={() => handleNavClick(SETTINGS_NAV_ITEM)}
              showLabels={showLabels}
            />
          </div>
        </nav>

        <GettingStartedLauncher compact={!showLabels} />

        <div className="flex flex-col gap-1 border-t px-2.5 py-3">
          {FOOTER_LINKS.map((item) => {
            const link = (
              <a
                className={cn(
                  "flex h-9 w-full items-center rounded-md transition-colors hover:bg-muted",
                  showLabels ? "gap-3 px-2" : "justify-center"
                )}
                href={item.href}
                key={item.label}
                rel="noopener"
                target="_blank"
              >
                <item.icon className="size-4 shrink-0" />
                {showLabels && (
                  <span className="truncate text-sm">{item.label}</span>
                )}
              </a>
            );

            if (showLabels) {
              return link;
            }

            return (
              <Tooltip key={item.label}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Resize handle */}
        {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle */}
        <div
          aria-orientation="vertical"
          aria-valuenow={currentWidth}
          className="group absolute inset-y-0 right-0 z-10 w-3 cursor-col-resize"
          onMouseDown={handleResizeStart}
          role="separator"
          tabIndex={0}
        >
          <div className="absolute inset-y-0 right-0 w-px bg-border" />
        </div>
      </div>

      {/* Panel 1: Workflows (lists projects + ungrouped workflows) */}
      <FlyoutPanel
        accentColor={selectedProject?.color ?? undefined}
        collapsedLabel={
          selectedProject ? `Workflows - ${selectedProject.name}` : "Workflows"
        }
        headerLeading={
          <PickerFilterButton
            filter={rootFilter}
            hasWorkflows={ungrouped.length > 0}
            loading={dataLoading}
            panelId={ROOT_FILTER_ROW_ID}
            panelName="Workflows"
          />
        }
        leftOffset={offsets.projects}
        onCollapse={() => navState.setPanelState("projects", "collapsed")}
        onExpand={() => navState.setPanelState("projects", "open")}
        state={navState.state.panels.projects}
        title="Workflows"
      >
        <WorkflowsRootList
          activeWorkflowId={workflowId}
          filter={rootFilter}
          isAnonymous={isAnonymous}
          onSelectProject={handleSelectProject}
          panelId={ROOT_FILTER_ROW_ID}
          selectedProjectId={selectedProjectId}
        />
      </FlyoutPanel>

      {/* Panel 2: Projects (workflows in a project, grouped by tag subheader) */}
      <FlyoutPanel
        collapsedLabel={
          selectedProject ? `Projects - ${selectedProject.name}` : "Projects"
        }
        headerLeading={
          <PickerFilterButton
            filter={projectFilter}
            hasWorkflows={allProjectWorkflows.length > 0}
            loading={dataLoading}
            panelId={PROJECT_FILTER_ROW_ID}
            panelName={selectedProject?.name ?? "Projects"}
          />
        }
        leftOffset={offsets.tags}
        onCollapse={() => navState.setPanelState("tags", "collapsed")}
        onExpand={() => navState.setPanelState("tags", "open")}
        state={navState.state.panels.tags}
        title={selectedProject?.name ?? "Projects"}
      >
        <ProjectWorkflowsList
          activeWorkflowId={workflowId}
          filter={projectFilter}
          panelId={PROJECT_FILTER_ROW_ID}
          projectId={selectedProjectId}
          projectName={selectedProject?.name ?? "Projects"}
        />
      </FlyoutPanel>

      {/* Fold/Close button outside the rightmost panel */}
      {anyPanelOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="pointer-events-auto fixed top-[calc(62px+var(--app-banner-height,0px))] z-40 rounded-md p-1.5 text-muted-foreground transition-[left,colors] duration-200 ease-out hover:bg-muted hover:text-foreground"
              data-flyout
              onClick={anyPanelExpanded ? navState.foldAll : navState.closeAll}
              style={{ left: offsets.rightEdge + 4 }}
              type="button"
            >
              <X className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {anyPanelExpanded ? "Fold menu" : "Close menu"}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
