"use client";

import {
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Globe,
  Info,
  List,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiscordIcon } from "@/components/icons/discord-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Project, SavedWorkflow, Tag } from "@/lib/api-client";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { NavPanelStates } from "@/lib/hooks/use-persisted-nav-state";
import { usePersistedNavState } from "@/lib/hooks/use-persisted-nav-state";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { registerSidebarRefetch } from "@/lib/refetch-sidebar";
import { cn } from "@/lib/utils";
import { FLYOUT_WIDTH, FlyoutPanel, STRIP_WIDTH } from "./flyout-panel";

export const COLLAPSED_WIDTH = 60;
export const EXPANDED_WIDTH = 200;
const SNAP_THRESHOLD = (COLLAPSED_WIDTH + EXPANDED_WIDTH) / 2;

type WorkflowEntry = {
  id: string;
  name: string;
  updatedAt: string;
  projectId?: string | null;
  tagId?: string | null;
};

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

function WorkflowItem({
  workflow,
  activeWorkflowId,
}: {
  workflow: WorkflowEntry;
  activeWorkflowId: string | undefined;
}): React.ReactNode {
  const router = useRouter();
  return (
    <button
      className={cn(
        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
        workflow.id === activeWorkflowId && "bg-muted"
      )}
      onClick={() => router.push(`/workflows/${workflow.id}`)}
      type="button"
    >
      <span className="truncate">{workflow.name}</span>
      {workflow.id === activeWorkflowId && (
        <Check className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
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
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
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
            <span className="truncate">{project.name}</span>
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

function TagsPanel({
  projectTags,
  untaggedWorkflows,
  selectedTagId,
  onSelectTag,
  activeWorkflowId,
  loading,
}: {
  projectTags: Tag[];
  untaggedWorkflows: WorkflowEntry[];
  selectedTagId: string | null;
  onSelectTag: (id: string) => void;
  activeWorkflowId: string | undefined;
  loading: boolean;
}): React.ReactNode {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAny = projectTags.length > 0 || untaggedWorkflows.length > 0;

  if (!hasAny) {
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        No workflows
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {projectTags.length > 0 && (
        <p className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Tags
        </p>
      )}
      {projectTags.map((tag) => {
        const isActive = tag.id === selectedTagId;
        return (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
              isActive && "bg-muted"
            )}
            key={tag.id}
            onClick={() => onSelectTag(tag.id)}
            type="button"
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: tag.color }}
            />
            <span className="truncate">{tag.name}</span>
            <span className="ml-auto text-muted-foreground text-xs">
              {tag.workflowCount}
            </span>
          </button>
        );
      })}
      {untaggedWorkflows.length > 0 && (
        <>
          {projectTags.length > 0 && (
            <>
              <div className="my-1 border-t" />
              <p className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                Other Workflows
              </p>
            </>
          )}
          {untaggedWorkflows.map((w) => (
            <WorkflowItem
              activeWorkflowId={activeWorkflowId}
              key={w.id}
              workflow={w}
            />
          ))}
        </>
      )}
    </div>
  );
}

function WorkflowsPanel({
  workflows,
  activeWorkflowId,
  loading,
}: {
  workflows: WorkflowEntry[];
  activeWorkflowId: string | undefined;
  loading: boolean;
}): React.ReactNode {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        No workflows
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {workflows.map((w) => (
        <WorkflowItem
          activeWorkflowId={activeWorkflowId}
          key={w.id}
          workflow={w}
        />
      ))}
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
        "flex items-center overflow-hidden border-b",
        expanded ? "px-3 py-2" : "relative justify-center pr-0.5 pt-3 pb-2"
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

function NavItem({
  item,
  active,
  showLabels,
  onClick,
}: {
  item: { id: string; icon: typeof Plus; label: string; href: string | null };
  active: boolean;
  showLabels: boolean;
  onClick: () => void;
}): React.ReactNode {
  const disabled = item.href === null && item.id !== "workflows";
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

const NAV_ITEMS = [
  {
    id: "workflows",
    icon: List,
    label: "All Workflows",
    href: null as string | null,
  },
  { id: "hub", icon: Globe, label: "Hub", href: "/hub" as string | null },
  {
    id: "analytics",
    icon: BarChart3,
    label: "Analytics",
    href: "/analytics" as string | null,
  },
  {
    id: "billing",
    icon: CreditCard,
    label: "Billing",
    href: "/billing" as string | null,
  },
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: large component with many panel interactions, further extraction would hurt readability
export function NavigationSidebar(): React.ReactNode {
  const isMobile = useIsMobile();
  const { data: session } = useSession();
  const { isOwner } = useActiveMember();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const navState = usePersistedNavState();

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const isDragging = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async (): Promise<void> => {
    try {
      const [w, p, t] = await Promise.all([
        api.workflow.getAll().catch(() => [] as SavedWorkflow[]),
        api.project.getAll().catch(() => [] as Project[]),
        api.tag.getAll().catch(() => [] as Tag[]),
      ]);
      setWorkflows(w);
      setProjects(p);
      setTags(t);
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData().catch(() => {
      /* intentional noop */
    });
  }, [fetchData]);

  useEffect(
    () =>
      registerSidebarRefetch((options) => {
        if (options?.closeFlyout) {
          navState.closeAll();
        }
        fetchData().catch(() => {
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

  const visibleWorkflows = workflows.filter((w) => w.name !== "__current__");

  const workflowId =
    typeof params.workflowId === "string" ? params.workflowId : undefined;
  const isHubPage = pathname === "/hub";
  const isAnalyticsPage = pathname === "/analytics";
  const isBillingPage = pathname === "/billing";

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
      if (e.key === "Escape") {
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
  }, [currentWidth]);

  if (isMobile || !navState.hasMounted) {
    return null;
  }

  // Derived data
  const { byProject, ungrouped } = groupWorkflows(visibleWorkflows);
  const selectedProjectId = navState.state.selectedProjectId;
  const selectedTagId = navState.state.selectedTagId;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectWorkflows = byProject[selectedProjectId ?? ""] ?? [];
  const projectTagIds = new Set(
    projectWorkflows.filter((w) => w.tagId).map((w) => w.tagId)
  );
  const projectTags = tags.filter((t) => projectTagIds.has(t.id));
  const untaggedWorkflows = projectWorkflows.filter((w) => !w.tagId);
  const tagWorkflows = projectWorkflows.filter((w) =>
    selectedTagId === "__untagged__" ? !w.tagId : w.tagId === selectedTagId
  );

  // Update tag workflow counts for the project context
  const projectTagsWithCounts = projectTags.map((t) => ({
    ...t,
    workflowCount: projectWorkflows.filter((w) => w.tagId === t.id).length,
  }));

  const selectedTag =
    selectedTagId === "__untagged__"
      ? { name: "Untagged" }
      : tags.find((t) => t.id === selectedTagId);

  const showLabels = currentWidth >= SNAP_THRESHOLD;
  const offsets = computePanelOffsets(currentWidth, navState.state.panels);

  function isActive(id: string): boolean {
    if (id === "workflows") {
      return navState.state.panels.projects !== "closed";
    }
    if (id === "hub") {
      return isHubPage;
    }
    if (id === "analytics") {
      return isAnalyticsPage;
    }
    if (id === "billing") {
      return isBillingPage;
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

  function handleNavClick(id: string, href: string | null): void {
    if (id === "workflows") {
      if (navState.state.panels.projects === "closed") {
        navState.setPanelState("projects", "open");
      } else {
        navState.closeAll();
      }
      return;
    }
    navState.closeAll();
    if (href) {
      router.push(href);
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
  }

  function handleSelectTag(id: string): void {
    if (id === selectedTagId) {
      // Re-clicking same tag toggles workflows panel
      if (navState.state.panels.workflows === "closed") {
        navState.setSelectedTag(id);
        navState.setPanelState("workflows", "open");
      } else {
        navState.setPanelState("workflows", "closed");
      }
      return;
    }
    navState.setSelectedTag(id);
    navState.setPanelState("workflows", "open");
  }

  const navItems = NAV_ITEMS.filter((item) => {
    if (item.id === "analytics") {
      return !isAnonymous;
    }
    if (item.id === "billing") {
      return isOwner && isBillingEnabled();
    }
    return true;
  });

  return (
    <>
      <div
        className={cn(
          "pointer-events-auto fixed top-[60px] bottom-0 left-0 z-40 flex flex-col bg-background",
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
              onClick={() => handleNavClick(item.id, item.href)}
              showLabels={showLabels}
            />
          ))}
        </nav>

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

      {/* Panel 1: Projects */}
      <FlyoutPanel
        accentColor={selectedProject?.color ?? undefined}
        collapsedLabel={
          selectedProject ? `Projects - ${selectedProject.name}` : "Projects"
        }
        leftOffset={offsets.projects}
        onCollapse={() => navState.setPanelState("projects", "collapsed")}
        onExpand={() => navState.setPanelState("projects", "open")}
        state={navState.state.panels.projects}
        title="All Workflows"
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

      {/* Panel 2: Tags */}
      <FlyoutPanel
        collapsedLabel={selectedTag ? `Tags - ${selectedTag.name}` : "Tags"}
        leftOffset={offsets.tags}
        onCollapse={() => navState.setPanelState("tags", "collapsed")}
        onExpand={() => navState.setPanelState("tags", "open")}
        state={navState.state.panels.tags}
        title={selectedProject?.name ?? "Tags"}
      >
        <TagsPanel
          activeWorkflowId={workflowId}
          loading={dataLoading}
          onSelectTag={handleSelectTag}
          projectTags={projectTagsWithCounts}
          selectedTagId={selectedTagId}
          untaggedWorkflows={untaggedWorkflows}
        />
      </FlyoutPanel>

      {/* Panel 3: Workflows */}
      <FlyoutPanel
        collapsedLabel={(() => {
          const wf = tagWorkflows.find((w) => w.id === workflowId);
          return wf ? `Workflows - ${wf.name}` : "Workflows";
        })()}
        leftOffset={offsets.workflows}
        onCollapse={() => navState.setPanelState("workflows", "collapsed")}
        onExpand={() => navState.setPanelState("workflows", "open")}
        state={navState.state.panels.workflows}
        title={selectedTag?.name ?? "Workflows"}
      >
        <WorkflowsPanel
          activeWorkflowId={workflowId}
          loading={dataLoading}
          workflows={tagWorkflows}
        />
      </FlyoutPanel>

      {/* Fold/Close button outside the rightmost panel */}
      {anyPanelOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="pointer-events-auto fixed top-[62px] z-40 rounded-md p-1.5 text-muted-foreground transition-[left,colors] duration-200 ease-out hover:bg-muted hover:text-foreground"
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
