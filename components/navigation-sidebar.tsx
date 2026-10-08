"use client";

import {
  Activity,
  BarChart3,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  Globe,
  Info,
  Loader2,
  Plus,
  Settings,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuthPrompt } from "@/components/auth/provider";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { GettingStartedLauncher } from "@/components/onboarding/getting-started-launcher";
import { AddressBookOverlay } from "@/components/overlays/address-book-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import {
  TRIGGER_FILTER_PANEL_ID,
  TriggerFilterButton,
  TriggerFilters,
} from "@/components/workflow-trigger-status";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Project, SavedWorkflow } from "@/lib/api-client";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isEscapeFromOverlay, isEscapeHandled } from "@/lib/escape-key";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { useProjects, useTags } from "@/lib/hooks/use-org-data";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { NavPanelStates } from "@/lib/hooks/use-persisted-nav-state";
import { usePersistedNavState } from "@/lib/hooks/use-persisted-nav-state";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { createLatestRequest } from "@/lib/latest-request";
import { registerSidebarRefetch } from "@/lib/refetch-sidebar";
import { cn, toggleInSet } from "@/lib/utils";
import { filterPickerVisible } from "@/lib/workflow/soft-delete";
import {
  countDeactivated,
  countTriggerStatuses,
  countTriggerTypes,
  describeEmptyFilterResult,
  getPickerTriggerType,
  listedTriggerTypes,
  matchesTriggerFilter,
  matchesTriggerTypeFilter,
  type TriggerFilter,
  type TriggerTypeFilter,
} from "@/lib/workflow/trigger-display";
import { getTriggerConfig } from "@/lib/workflow/trigger-display-key";
import { FLYOUT_WIDTH, FlyoutPanel, STRIP_WIDTH } from "./flyout-panel";
import {
  TagsPanel,
  type WorkflowEntry,
  WorkflowItem,
} from "./workflow-picker-list";

export const COLLAPSED_WIDTH = 60;
export const EXPANDED_WIDTH = 200;
const SNAP_THRESHOLD = (COLLAPSED_WIDTH + EXPANDED_WIDTH) / 2;

function groupWorkflows(workflows: WorkflowEntry[]): {
  byProject: Record<string, WorkflowEntry[]>;
  ungrouped: WorkflowEntry[];
} {
  const byProject: Record<string, WorkflowEntry[]> = {};
  const ungrouped: WorkflowEntry[] = [];

  for (const workflow of workflows) {
    if (workflow.projectId) {
      if (!byProject[workflow.projectId]) {
        byProject[workflow.projectId] = [];
      }
      byProject[workflow.projectId].push(workflow);
    } else {
      ungrouped.push(workflow);
    }
  }

  return { byProject, ungrouped };
}

// How long the result count must stay the same before it is announced.
const ANNOUNCE_DELAY_MS = 400;

// A polite live region that speaks only once the text has stopped changing
// for a moment, so a quick run of filter picks is announced once.
function DelayedAnnouncement({ text }: { text: string }): React.ReactNode {
  const announced = useDebounce(text, ANNOUNCE_DELAY_MS);
  return (
    <p aria-live="polite" className="sr-only">
      {announced}
    </p>
  );
}

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

function ProjectsPanel({
  projects,
  ungrouped,
  byProject,
  activeWorkflowId,
  selectedProjectId,
  onSelectProject,
  loading,
  isAnonymous,
}: {
  projects: Project[];
  ungrouped: WorkflowEntry[];
  byProject: Record<string, WorkflowEntry[]>;
  activeWorkflowId: string | undefined;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  loading: boolean;
  isAnonymous: boolean;
}): React.ReactNode {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAny = projects.length > 0 || ungrouped.length > 0;

  if (!hasAny) {
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        {isAnonymous ? "Sign in to save workflows" : "No workflows found"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {projects.length > 0 && (
        <p className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Projects
        </p>
      )}
      {projects.map((project) => {
        const projectWorkflows = byProject[project.id] ?? [];
        const isActive = project.id === selectedProjectId;
        return (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-inset",
              isActive && "bg-muted"
            )}
            key={project.id}
            onClick={() => onSelectProject(project.id)}
            type="button"
          >
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor: project.color ?? "var(--color-text-muted)",
              }}
            />
            <TruncatedTooltip side="right" text={project.name} />
            <span className="ml-auto flex items-center gap-1 text-muted-foreground text-xs">
              {projectWorkflows.length}
              <ChevronRight className="size-3.5" />
            </span>
          </button>
        );
      })}

      {ungrouped.length > 0 && (
        <>
          {projects.length > 0 && (
            <>
              <div className="my-1 border-t" />
              <p className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                Other Workflows
              </p>
            </>
          )}
          {ungrouped.map((w) => (
            <WorkflowItem
              activeWorkflowId={activeWorkflowId}
              key={w.id}
              workflow={w}
            />
          ))}
        </>
      )}
      {isAnonymous && hasAny && (
        <p className="mt-2 border-t px-2 pt-2 text-center text-muted-foreground/70 text-xs">
          Sign in to create more
        </p>
      )}
    </div>
  );
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
            ? "group/new flex items-center gap-1.5 whitespace-nowrap rounded-md border border-keeperhub-green/20 bg-keeperhub-green/10 px-2 py-1 text-keeperhub-green text-sm font-medium transition-all duration-200 hover:border-keeperhub-green/40 hover:bg-keeperhub-green/15 hover:shadow-[0_0_8px_rgba(0,255,100,0.08)] active:scale-[0.97]"
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

type NavItemDef = {
  id: string;
  icon: typeof Plus;
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
const SETTINGS_NAV_ITEM: NavItemDef = {
  id: "settings",
  icon: Settings,
  label: "Settings",
  href: "/settings",
  requireAuth: true,
};

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
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  // Shared with the toolbar and settings, so the sidebar reads them rather
  // than fetching its own copy.
  const { data: projects } = useProjects();
  const { data: tags } = useTags();
  const [dataLoading, setDataLoading] = useState(true);
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>(
    () => new Set()
  );
  const [triggerTypeFilter, setTriggerTypeFilter] = useState<TriggerTypeFilter>(
    () => new Set()
  );
  const [triggerFilterOpen, setTriggerFilterOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const isPickerFiltered = triggerFilter.size > 0 || triggerTypeFilter.size > 0;
  // A reply that lands after a newer list request was sent is dropped rather
  // than put back over the newer list.
  const latestFetch = useRef(createLatestRequest());
  // The organization the session is in, and the one the shown list was
  // loaded for. A failed fetch keeps the shown list only while they match.
  const sessionOrg = useRef<string | null>(null);
  const listOrg = useRef<string | null>(null);
  const isDragging = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(
    async (options?: { clearOnFailure?: boolean }): Promise<void> => {
      const result = await latestFetch.current(() => api.workflow.getAll());
      // Only the latest request settles the list and the loading state.
      if (!result.latest) {
        return;
      }
      if (result.ok) {
        setWorkflows(result.value);
        // The org is read on reply: a reply sent before an org switch is
        // never the latest, as the session refresh sends a newer one.
        listOrg.current = sessionOrg.current;
      } else if (
        options?.clearOnFailure ||
        sessionOrg.current !== listOrg.current
      ) {
        // A failed refetch keeps the list already shown, unless it belongs
        // to another organization. A failed first load leaves it empty.
        setWorkflows([]);
        listOrg.current = sessionOrg.current;
      }
      setDataLoading(false);
    },
    []
  );

  useEffect(() => {
    // NAV-04: gate fetchData on session resolution. While pending, do nothing
    // (the isPending skeleton renders). When signed-out / anonymous, skip the
    // network call entirely and clear the loading flag so the sidebar is not
    // stuck spinning. Only authenticated users hit /api/workflow.getAll etc.
    if (isPending) {
      return;
    }
    if (!session?.user || isAnonymousUser(session.user)) {
      setDataLoading(false);
      return;
    }
    // Every org switch refreshes the session, whichever code path made it.
    sessionOrg.current =
      (session.session as { activeOrganizationId?: string | null })
        .activeOrganizationId ?? null;
    fetchData().catch(() => {
      /* intentional noop */
    });
  }, [isPending, session, fetchData]);

  // Drops both filters and hides the filter row.
  const clearPickerFilters = useCallback((): void => {
    setTriggerFilter(new Set());
    setTriggerTypeFilter(new Set());
    setTriggerFilterOpen(false);
  }, []);

  // Closing the project panel any way at all (Escape, clicking outside, the
  // close button, re-clicking the project) drops the filters.
  const tagsPanelState = navState.state.panels.tags;
  useEffect(() => {
    if (tagsPanelState === "closed") {
      clearPickerFilters();
    }
  }, [tagsPanelState, clearPickerFilters]);

  useEffect(
    () =>
      registerSidebarRefetch((options) => {
        if (options?.closeFlyout) {
          navState.closeAll();
        }
        fetchData({ clearOnFailure: options?.orgChanged }).catch(() => {
          /* intentional noop */
        });
      }),
    [fetchData, navState.closeAll]
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

  // A save that changes a workflow's trigger refetches the list (see
  // refetchSidebarIfTriggerChanged), so the rows read it from the fetched
  // nodes. Built once per fetch, so the rows (memoized) skip the trigger
  // labels and cron parsing on unrelated re-renders such as a drag-resize.
  const visibleWorkflows = useMemo(
    () =>
      filterPickerVisible(workflows).map((w) => {
        const triggerConfig = getTriggerConfig(w.nodes);
        return {
          ...w,
          triggerConfig,
          triggerType: getPickerTriggerType(triggerConfig),
        };
      }),
    [workflows]
  );

  const workflowId =
    typeof params.workflowId === "string" ? params.workflowId : undefined;
  const isWorkflowsPage =
    pathname === "/workflows" || pathname.startsWith("/workflows/");
  const isHubPage = pathname === "/hub";
  const isAnalyticsPage = pathname === "/analytics";
  const isEarningsPage = pathname === "/earnings";
  const isHeldPaymentsPage = pathname === "/held-payments";
  const isActivityPage = pathname === "/activity";
  const isSettingsPage = pathname.startsWith("/settings");

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
  const { byProject, ungrouped } = groupWorkflows(visibleWorkflows);
  const selectedProjectId = navState.state.selectedProjectId;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const allProjectWorkflows = byProject[selectedProjectId ?? ""] ?? [];
  // Each menu counts the workflows the other menu lets through, so its
  // numbers say what picking an entry would show.
  const typeFiltered = allProjectWorkflows.filter((w) =>
    matchesTriggerTypeFilter(w, triggerTypeFilter)
  );
  const statusCounts = countTriggerStatuses(typeFiltered);
  const typeMatches = allProjectWorkflows.filter((w) =>
    matchesTriggerFilter(w, triggerFilter)
  );
  const typeCounts = countTriggerTypes(typeMatches);
  const listedTypes = listedTriggerTypes(
    allProjectWorkflows,
    triggerTypeFilter
  );
  const projectWorkflows = typeMatches.filter((w) =>
    matchesTriggerTypeFilter(w, triggerTypeFilter)
  );
  // Escape on a menu button hides an unused row; it never throws away picks
  // (a second, habitual Escape after closing a menu would), so with a filter
  // on it does nothing and the × or the filter button clears them.
  const onFilterEscape = (): void => {
    if (!isPickerFiltered) {
      setTriggerFilterOpen(false);
      filterButtonRef.current?.focus();
    }
  };
  // The filter button: with a filter on it clears the filters and hides the
  // row in one go, so the row never hides while it is shortening the list.
  const toggleFilterRow = (): void => {
    if (triggerFilterOpen && isPickerFiltered) {
      clearPickerFilters();
      return;
    }
    setTriggerFilterOpen(!triggerFilterOpen);
  };
  const resetPickerFilter = (): void => {
    setTriggerFilter(new Set());
    setTriggerTypeFilter(new Set());
    filterButtonRef.current?.focus();
  };
  const projectTagIds = new Set(
    projectWorkflows.filter((w) => w.tagId).map((w) => w.tagId)
  );
  const projectTags = tags.filter((t) => projectTagIds.has(t.id));
  const untaggedWorkflows = projectWorkflows.filter((w) => !w.tagId);

  // Update tag workflow counts for the project context
  const projectTagsWithCounts = projectTags.map((t) => ({
    ...t,
    workflowCount: projectWorkflows.filter((w) => w.tagId === t.id).length,
  }));

  const projectWorkflowsByTagId: Record<string, WorkflowEntry[]> = {};
  for (const w of projectWorkflows) {
    if (w.tagId) {
      projectWorkflowsByTagId[w.tagId] ??= [];
      projectWorkflowsByTagId[w.tagId].push(w);
    }
  }

  const showLabels = currentWidth >= SNAP_THRESHOLD;
  const offsets = computePanelOffsets(currentWidth, navState.state.panels);

  function isActive(id: string): boolean {
    // Route-based like every other item; the flyout state is not "you are here".
    if (id === "workflows") {
      return isWorkflowsPage;
    }
    if (id === "hub") {
      return isHubPage;
    }
    if (id === "analytics") {
      return isAnalyticsPage;
    }
    if (id === "earnings") {
      return isEarningsPage;
    }
    if (id === "held-payments") {
      return isHeldPaymentsPage;
    }
    if (id === "activity") {
      return isActivityPage;
    }
    return false;
  }

  async function handleNewWorkflow(): Promise<void> {
    if (isAnonymous) {
      if (!session) {
        await authClient.signIn.anonymous();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const existing = await api.workflow
        .getAll()
        .catch(() => [] as SavedWorkflow[]);
      const visible = existing.filter((w) => w.name !== "__current__");
      if (visible.length > 0) {
        // Anonymous users are capped at one workflow. Surface the cap so the
        // click isn't silently a no-op visually, then drop them onto their
        // existing workflow.
        toast.info("Sign in to create more workflows.");
        const latest = visible.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )[0];
        router.push(`/workflows/${latest.id}`);
        return;
      }
      const newWorkflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes: [],
        edges: [],
      });
      await fetchData();
      navState.setPanelState("projects", "open");
      sessionStorage.setItem("animate-sidebar", "true");
      router.push(`/workflows/${newWorkflow.id}`);
      return;
    }
    const newWorkflow = await api.workflow.create({
      name: "Untitled Workflow",
      description: "",
      nodes: [],
      edges: [],
    });
    await fetchData();
    navState.setPanelState("projects", "open");
    sessionStorage.setItem("animate-sidebar", "true");
    router.push(`/workflows/${newWorkflow.id}`);
  }

  function handleNavClick(item: NavItemDef): void {
    // NAV-02: requireAuth items click-gate to the shared auth modal instead
    // of routing to a 401 page when the user is signed-out or anonymous.
    if (item.requireAuth && (!session?.user || isAnonymousUser(session.user))) {
      openAuthPrompt({
        action: `nav:${item.id}`,
        redirectTo: item.href ?? undefined,
      });
      return;
    }

    if (item.id === "workflows") {
      if (navState.state.panels.projects === "closed") {
        navState.setPanelState("projects", "open");
      } else {
        navState.closeAll();
      }
      return;
    }
    if (item.id === "address-book") {
      openOverlay(AddressBookOverlay);
      return;
    }
    // Keep the workflows flyout open when moving between pages so the picker
    // stays available instead of collapsing on every navigation.
    if (item.href) {
      router.push(item.href);
    }
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
    clearPickerFilters();
  }

  // NAV-01: render every nav item for everyone (anonymous, signed-out, signed-in).
  // Click-gating for requireAuth items happens in handleNavClick. The exception
  // is adminOnly items (e.g. org Activity), hidden for non-owner/admin members.
  const navItems = NAV_ITEMS.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.ownerOnly || isOwner)
  );

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
            handleNewWorkflow().catch(() => {
              router.push("/");
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
              active={isActive(item.id)}
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
          {(
            [
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
            ] as const
          ).map((item) => {
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
        leftOffset={offsets.projects}
        onCollapse={() => navState.setPanelState("projects", "collapsed")}
        onExpand={() => navState.setPanelState("projects", "open")}
        state={navState.state.panels.projects}
        title="Workflows"
      >
        <ProjectsPanel
          activeWorkflowId={workflowId}
          byProject={byProject}
          isAnonymous={isAnonymous}
          loading={dataLoading}
          onSelectProject={handleSelectProject}
          projects={projects}
          selectedProjectId={selectedProjectId}
          ungrouped={ungrouped}
        />
      </FlyoutPanel>

      {/* Panel 2: Projects (workflows in a project, grouped by tag subheader) */}
      <FlyoutPanel
        collapsedLabel={
          selectedProject ? `Projects - ${selectedProject.name}` : "Projects"
        }
        headerLeading={
          <TriggerFilterButton
            disabled={dataLoading || allProjectWorkflows.length === 0}
            filtered={isPickerFiltered}
            onToggle={toggleFilterRow}
            open={triggerFilterOpen}
            ref={filterButtonRef}
          />
        }
        leftOffset={offsets.tags}
        onCollapse={() => navState.setPanelState("tags", "collapsed")}
        onExpand={() => navState.setPanelState("tags", "open")}
        state={navState.state.panels.tags}
        title={selectedProject?.name ?? "Projects"}
      >
        {triggerFilterOpen && !dataLoading && (
          // Pinned to the top of the scrolling list, so the sign that a
          // filter is on stays in view on long lists. The negative offsets
          // cover the panel's p-2 padding.
          <div
            className="fade-in-0 slide-in-from-top-1 sticky -top-2 z-10 -mx-2 -mt-2 mb-1 animate-in border-b bg-background px-2 pt-2 duration-150 motion-reduce:animate-none"
            id={TRIGGER_FILTER_PANEL_ID}
          >
            <TriggerFilters
              deactivatedCount={countDeactivated(typeFiltered)}
              listedTypes={listedTypes}
              onClearAll={resetPickerFilter}
              onClearStatus={() => setTriggerFilter(new Set())}
              onClearTypes={() => setTriggerTypeFilter(new Set())}
              onEscape={onFilterEscape}
              onToggleStatus={(status) =>
                setTriggerFilter((current) => toggleInSet(current, status))
              }
              onToggleType={(type) =>
                setTriggerTypeFilter((current) => toggleInSet(current, type))
              }
              status={triggerFilter}
              statusCounts={statusCounts}
              typeCounts={typeCounts}
              types={triggerTypeFilter}
            />
          </div>
        )}
        <DelayedAnnouncement
          text={
            isPickerFiltered
              ? `${projectWorkflows.length} of ${allProjectWorkflows.length} workflows shown`
              : ""
          }
        />
        <TagsPanel
          activeWorkflowId={workflowId}
          expandAll={isPickerFiltered}
          filteredEmptyText={describeEmptyFilterResult(
            triggerFilter,
            triggerTypeFilter
          )}
          loading={dataLoading}
          onResetFilter={isPickerFiltered ? resetPickerFilter : undefined}
          projectTags={projectTagsWithCounts}
          untaggedWorkflows={untaggedWorkflows}
          workflowsByTagId={projectWorkflowsByTagId}
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
