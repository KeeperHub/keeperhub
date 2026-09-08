"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { TagFormDialog } from "@/components/tags/tag-form-dialog";
import { Button } from "@/components/ui/button";
import type { Project, Tag } from "@/lib/api-client";
import { useProjectsTags } from "./hooks/use-projects-tags";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { GroupingTable } from "./workspace/grouping-table";

export function WorkspaceSection(): React.ReactElement {
  const data = useProjectsTags();
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const [tagDialog, setTagDialog] = useState(false);

  const openProject = (project: Project | null): void => {
    setEditingProject(project);
    setProjectDialog(true);
  };
  const openTag = (tag: Tag | null): void => {
    setEditingTag(tag);
    setTagDialog(true);
  };

  return (
    <>
      <SectionHeader
        description="How workflows are grouped in the sidebar for everyone in this organization."
        title="Projects and tags"
      />

      <SettingsCard
        action={
          <Button onClick={() => openProject(null)} size="sm" variant="outline">
            <Plus className="size-3.5" />
            New project
          </Button>
        }
        bodyClassName="p-2"
        description="The top-level grouping in the workflows sidebar."
        title="Projects"
      >
        {!data.loadingProjects && data.projects.length === 0 && (
          <EmptyState>No projects yet.</EmptyState>
        )}
        {(data.loadingProjects || data.projects.length > 0) && (
          <GroupingTable
            canManage
            loading={data.loadingProjects}
            onDelete={async (id) => {
              const project = data.projects.find((p) => p.id === id);
              if (project) {
                await data.deleteProject(project);
              }
            }}
            onEdit={(id) =>
              openProject(data.projects.find((p) => p.id === id) ?? null)
            }
            rows={data.projects}
            unit="project"
          />
        )}
      </SettingsCard>

      <SettingsCard
        action={
          <Button onClick={() => openTag(null)} size="sm" variant="outline">
            <Plus className="size-3.5" />
            New tag
          </Button>
        }
        bodyClassName="p-2"
        description="Tags subdivide a project in the second sidebar panel."
        title="Tags"
      >
        {!data.loadingTags && data.tags.length === 0 && (
          <EmptyState>No tags yet.</EmptyState>
        )}
        {(data.loadingTags || data.tags.length > 0) && (
          <GroupingTable
            canManage
            loading={data.loadingTags}
            onDelete={async (id) => {
              const tag = data.tags.find((t) => t.id === id);
              if (tag) {
                await data.deleteTag(tag);
              }
            }}
            onEdit={(id) => openTag(data.tags.find((t) => t.id === id) ?? null)}
            rows={data.tags}
            unit="tag"
          />
        )}
      </SettingsCard>

      <ProjectFormDialog
        onCreated={data.upsertProject}
        onOpenChange={setProjectDialog}
        onUpdated={data.upsertProject}
        open={projectDialog}
        project={editingProject}
      />
      <TagFormDialog
        onCreated={data.upsertTag}
        onOpenChange={setTagDialog}
        onUpdated={data.upsertTag}
        open={tagDialog}
        tag={editingTag}
      />
    </>
  );
}
