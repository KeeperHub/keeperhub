"use client";

import {
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Globe,
  List,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { registerSidebarRefetch } from "@/keeperhub/lib/refetch-sidebar";
import type { Project, SavedWorkflow, Tag } from "@/lib/api-client";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { NavPanelStates } from "../lib/hooks/use-persisted-nav-state";
import { usePersistedNavState } from "../lib/hooks/use-persisted-nav-state";
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
}: {
  projects: Project[];
  ungrouped: WorkflowEntry[];
  byProject: Record<string, WorkflowEntry[]>;
  activeWorkflowId: string | undefined;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  loading: boolean;
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
        No workflows found
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
              style={{ backgroundColor: project.color ?? "#888" }}
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

export function NavigationSidebar(): React.ReactNode {
  const isMobile = useIsMobile();
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
        api.workflow.getAll(),
        api.project.getAll(),
        api.tag.getAll(),
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

  const visibleWorkflows = workflows.filter((w) => w.name !== "__current__");

  const workflowId =
    typeof params.workflowId === "string" ? params.workflowId : undefined;
  const isHubPage = pathname === "/hub";

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

  if (isMobile) {
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
    if (id === "new") {
      return !(workflowId || isHubPage);
    }
    if (id === "workflows") {
      return navState.state.panels.projects !== "closed";
    }
    if (id === "hub") {
      return isHubPage;
    }
    return false;
  }

  function handleNavClick(id: string, href: string | null): void {
    if (id === "workflows") {
      if (navState.state.panels.projects !== "closed") {
        navState.closeAll();
      } else {
        navState.setPanelState("projects", "open");
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
      if (navState.state.panels.tags !== "closed") {
        navState.setPanelState("tags", "closed");
      } else {
        navState.setSelectedProject(id);
        navState.setPanelState("tags", "open");
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
      if (navState.state.panels.workflows !== "closed") {
        navState.setPanelState("workflows", "closed");
      } else {
        navState.setSelectedTag(id);
        navState.setPanelState("workflows", "open");
      }
      return;
    }
    navState.setSelectedTag(id);
    navState.setPanelState("workflows", "open");
  }

  function renderNavItem(item: {
    id: string;
    icon: typeof Plus;
    label: string;
    href: string | null;
  }): React.ReactNode {
    const disabled = item.href === null && item.id !== "workflows";
    const layoutClass = showLabels ? "gap-3 px-2" : "justify-center";

    if (disabled) {
      return (
        <Tooltip key={item.id}>
          <TooltipTrigger asChild>
            <button
              aria-label={item.label}
              className={cn(
                "flex h-9 w-full cursor-default items-center rounded-md text-muted-foreground transition-colors",
                layoutClass
              )}
              data-testid={`nav-${item.id}`}
              key={item.id}
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

    const active = isActive(item.id);

    const button = (
      <button
        aria-label={item.label}
        className={cn(
          "flex h-9 w-full items-center rounded-md transition-colors hover:bg-muted",
          layoutClass,
          active && "bg-muted"
        )}
        data-testid={`nav-${item.id}`}
        key={item.id}
        onClick={() => handleNavClick(item.id, item.href)}
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
      <Tooltip key={item.id}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  const navItems = [
    {
      id: "new",
      icon: Plus,
      label: "New Workflow",
      href: "/" as string | null,
    },
    {
      id: "workflows",
      icon: List,
      label: "All Workflows",
      href: null,
    },
    { id: "hub", icon: Globe, label: "Hub", href: "/hub" as string | null },
    {
      id: "analytics",
      icon: BarChart3,
      label: "Analytics",
      href: "/analytics" as string | null,
    },
  ];

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
        <nav
          aria-label="Main navigation"
          className="flex flex-1 flex-col gap-1 overflow-hidden px-2.5 pt-3"
          data-testid="navigation-sidebar"
        >
          {navItems.map(renderNavItem)}
        </nav>

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
          <div className="absolute inset-y-0 right-0 w-px bg-border transition-colors group-hover:w-1 group-hover:bg-blue-500 group-active:w-1 group-active:bg-blue-600" />
          {dragWidth === null && (
            <button
              aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
              className="-translate-y-1/2 absolute top-1/2 right-0 flex size-6 translate-x-1/2 items-center justify-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              type="button"
            >
              {expanded ? (
                <ChevronLeft className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Panel 1: Projects */}
      <FlyoutPanel
        collapsedLabel="Projects"
        leftOffset={offsets.projects}
        onCollapse={() => navState.setPanelState("projects", "collapsed")}
        onExpand={() => navState.setPanelState("projects", "open")}
        state={navState.state.panels.projects}
        title="All Workflows"
      >
        <ProjectsPanel
          activeWorkflowId={workflowId}
          byProject={byProject}
          loading={dataLoading}
          onSelectProject={handleSelectProject}
          projects={projects}
          selectedProjectId={selectedProjectId}
          ungrouped={ungrouped}
        />
      </FlyoutPanel>

      {/* Panel 2: Tags */}
      <FlyoutPanel
        collapsedLabel={selectedProject?.name}
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
        collapsedLabel={selectedTag?.name}
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

      {/* Close-all button outside the rightmost panel */}
      {anyPanelOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="pointer-events-auto fixed top-[68px] z-40 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-[left] duration-200 ease-out hover:bg-muted hover:text-foreground"
              data-flyout
              onClick={navState.closeAll}
              style={{ left: offsets.rightEdge + 6 }}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Close menu</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
