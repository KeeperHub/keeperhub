"use client";

import type { Tag } from "@/lib/api-client";
import { usePickerData } from "./workflow-picker-data";
import {
  applyPickerFilter,
  type PickerFilter,
  PickerFilterRow,
} from "./workflow-picker-filter";
import {
  type PickerRowSize,
  ProjectsPanel,
  TagsPanel,
  type WorkflowEntry,
} from "./workflow-picker-list";

// The two workflow lists with their filter rows, shared by the sidebar's
// flyouts and the phone drawer.

type ListProps = {
  filter: PickerFilter;
  // The id of the filter row, for its button's aria-controls.
  panelId: string;
  activeWorkflowId: string | undefined;
  size?: PickerRowSize;
  onOpenWorkflow?: (workflowId: string) => void;
};

/** Projects, then the workflows outside any project. */
export function WorkflowsRootList({
  filter,
  panelId,
  activeWorkflowId,
  selectedProjectId,
  onSelectProject,
  isAnonymous,
  size,
  onOpenWorkflow,
}: ListProps & {
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  isAnonymous: boolean;
}): React.ReactNode {
  const { projects, byProject, ungrouped, loading } = usePickerData();
  const shownUngrouped = applyPickerFilter(ungrouped, filter);
  return (
    <>
      <PickerFilterRow
        filter={filter}
        loading={loading}
        panelId={panelId}
        panelName="Workflows"
        shownCount={shownUngrouped.length}
        workflows={ungrouped}
      />
      <ProjectsPanel
        activeWorkflowId={activeWorkflowId}
        byProject={byProject}
        // The project rows above are not filtered, so the message says
        // which workflows it is about.
        filteredEmptyText={`${filter.emptyText} outside a project`}
        isAnonymous={isAnonymous}
        loading={loading}
        onOpenWorkflow={onOpenWorkflow}
        onResetFilter={filter.isFiltered ? filter.reset : undefined}
        onSelectProject={onSelectProject}
        projects={projects}
        selectedProjectId={selectedProjectId}
        size={size}
        ungrouped={shownUngrouped}
        ungroupedTotal={ungrouped.length}
      />
    </>
  );
}

// A project's tags that hold any of the given workflows (with their counts),
// the workflows under each, and the untagged ones.
function groupByTag(
  workflows: WorkflowEntry[],
  tags: Tag[]
): {
  projectTags: Tag[];
  byTagId: Record<string, WorkflowEntry[]>;
  untagged: WorkflowEntry[];
} {
  const byTagId: Record<string, WorkflowEntry[]> = {};
  const untagged: WorkflowEntry[] = [];
  for (const w of workflows) {
    if (w.tagId) {
      byTagId[w.tagId] ??= [];
      byTagId[w.tagId].push(w);
    } else {
      untagged.push(w);
    }
  }
  const projectTags = tags
    .filter((t) => byTagId[t.id])
    .map((t) => ({ ...t, workflowCount: byTagId[t.id].length }));
  return { projectTags, byTagId, untagged };
}

/** One project's workflows, grouped by tag. */
export function ProjectWorkflowsList({
  projectId,
  projectName,
  filter,
  panelId,
  activeWorkflowId,
  size,
  onOpenWorkflow,
}: ListProps & {
  projectId: string | null;
  projectName: string;
}): React.ReactNode {
  const { byProject, tags, loading } = usePickerData();
  const all = byProject[projectId ?? ""] ?? [];
  const shown = applyPickerFilter(all, filter);
  const { projectTags, byTagId, untagged } = groupByTag(shown, tags);
  return (
    <>
      <PickerFilterRow
        filter={filter}
        loading={loading}
        panelId={panelId}
        panelName={projectName}
        shownCount={shown.length}
        workflows={all}
      />
      <TagsPanel
        activeWorkflowId={activeWorkflowId}
        expandAll={filter.isFiltered}
        filteredEmptyText={filter.emptyText}
        loading={loading}
        onOpenWorkflow={onOpenWorkflow}
        onResetFilter={filter.isFiltered ? filter.reset : undefined}
        projectTags={projectTags}
        size={size}
        untaggedWorkflows={untagged}
        workflowsByTagId={byTagId}
      />
    </>
  );
}
