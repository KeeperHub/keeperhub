"use client";

import { ChevronLeft } from "lucide-react";
import { useEffect, useLayoutEffect } from "react";
import { usePickerData } from "./workflow-picker-data";
import { PickerFilterButton, usePickerFilter } from "./workflow-picker-filter";
import {
  ProjectWorkflowsList,
  WorkflowsRootList,
} from "./workflow-picker-panels";

// The phone drawer's Workflows: the sidebar's two flyouts as levels of the
// drawer, the projects first, then one project's workflows.

export type DrawerView =
  | { level: "menu" }
  | { level: "workflows" }
  | { level: "project"; projectId: string };

const ROOT_FILTER_ROW_ID = "mobile-nav-root-filter";
const PROJECT_FILTER_ROW_ID = "mobile-nav-project-filter";

// Marks the level's title, which takes focus when a level opens.
export const LEVEL_TITLE_ATTR = "data-level-title";

export function MobileNavWorkflows({
  view,
  activeWorkflowId,
  activeProjectId,
  isAnonymous,
  onBack,
  onSelectProject,
  onOpenWorkflow,
  onListShown,
}: {
  view: Exclude<DrawerView, { level: "menu" }>;
  activeWorkflowId: string | undefined;
  // The project the open workflow is in.
  activeProjectId: string | null;
  isAnonymous: boolean;
  onBack: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenWorkflow: (workflowId: string) => void;
  // Called each time the shown list becomes loaded (or mounts loaded).
  onListShown: () => void;
}): React.ReactNode {
  const { projects, byProject, ungrouped, loading, projectsLoading } =
    usePickerData();
  // Leaving Workflows for the menu unmounts both filters; leaving a project
  // closes its filter's panel, which clears it.
  const rootFilter = usePickerFilter("open");
  const projectFilter = usePickerFilter(
    view.level === "project" ? "open" : "closed"
  );
  const project =
    view.level === "project"
      ? projects.find((p) => p.id === view.projectId)
      : undefined;
  const listsLoaded = !(loading || projectsLoading);
  const projectGone = view.level === "project" && listsLoaded && !project;

  // Rows that appear late can land under a tap meant for the spinner. A
  // project's rows depend on the workflow list only.
  const shownListLoaded = view.level === "project" ? !loading : listsLoaded;
  useLayoutEffect(() => {
    if (shownListLoaded) {
      onListShown();
    }
  }, [shownListLoaded, onListShown]);

  // A project deleted, or left behind by an org switch, goes back to the list.
  useEffect(() => {
    if (projectGone) {
      onBack();
    }
  }, [projectGone, onBack]);

  const inProject = view.level === "project";
  const title = inProject ? (project?.name ?? "Project") : "Workflows";
  const filter = inProject ? projectFilter : rootFilter;
  const filterRowId = inProject ? PROJECT_FILTER_ROW_ID : ROOT_FILTER_ROW_ID;
  const hasWorkflows = inProject
    ? (byProject[view.projectId] ?? []).length > 0
    : ungrouped.length > 0;

  return (
    // data-flyout keeps the filter menus inside the drawer.
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-flyout
      data-testid="mobile-nav-workflows-level"
    >
      {/* Leaves the drawer's close button (44px at right-1) and the filter
          button's 10px tap margin clear of each other. */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b pr-15 pl-0.5">
        <button
          aria-label={inProject ? "Back to Workflows" : "Back to menu"}
          className="flex size-11 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-foreground/60"
          data-testid="mobile-nav-back"
          onClick={onBack}
          type="button"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h2
          className="flex min-w-0 flex-1 items-center gap-2 font-medium text-sm outline-none"
          data-testid="mobile-nav-level-title"
          {...{ [LEVEL_TITLE_ATTR]: "" }}
          tabIndex={-1}
        >
          {project ? (
            <span
              aria-hidden="true"
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor: project.color ?? "var(--color-text-muted)",
              }}
            />
          ) : null}
          <span className="truncate">{title}</span>
        </h2>
        {/* A 44px target around the 24px button. */}
        <PickerFilterButton
          className="before:absolute before:-inset-2.5 before:content-['']"
          filter={filter}
          hasWorkflows={hasWorkflows}
          loading={loading}
          panelId={filterRowId}
          panelName={title}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {inProject ? (
          <ProjectWorkflowsList
            activeWorkflowId={activeWorkflowId}
            filter={projectFilter}
            onOpenWorkflow={onOpenWorkflow}
            panelId={PROJECT_FILTER_ROW_ID}
            projectId={view.projectId}
            projectName={title}
            size="touch"
          />
        ) : (
          <WorkflowsRootList
            activeWorkflowId={activeWorkflowId}
            filter={rootFilter}
            isAnonymous={isAnonymous}
            onOpenWorkflow={onOpenWorkflow}
            onSelectProject={onSelectProject}
            panelId={ROOT_FILTER_ROW_ID}
            selectedProjectId={activeProjectId}
            size="touch"
          />
        )}
      </div>
    </div>
  );
}
