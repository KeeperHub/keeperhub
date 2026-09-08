"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { api, type Project, type Tag } from "@/lib/api-client";
import { useProjects, useTags } from "@/lib/hooks/use-org-data";

export type ProjectsTagsState = {
  projects: Project[];
  tags: Tag[];
  loadingProjects: boolean;
  loadingTags: boolean;
  upsertProject: (project: Project) => void;
  upsertTag: (tag: Tag) => void;
  deleteProject: (project: Project) => Promise<void>;
  deleteTag: (tag: Tag) => Promise<void>;
};

/**
 * Projects and tags come from the shared store, so they are fetched once for
 * the whole app and reload on their own when the organization changes.
 */
export function useProjectsTags(): ProjectsTagsState {
  const projects = useProjects();
  const tags = useTags();

  const upsertProject = useCallback((): void => {
    projects.refetch().catch(() => undefined);
  }, [projects.refetch]);

  const upsertTag = useCallback((): void => {
    tags.refetch().catch(() => undefined);
  }, [tags.refetch]);

  const deleteProject = useCallback(
    async (project: Project): Promise<void> => {
      try {
        await api.project.delete(project.id);
        await projects.refetch();
        toast.success(`Deleted ${project.name}`);
      } catch {
        toast.error("Failed to delete project");
      }
    },
    [projects.refetch]
  );

  const deleteTag = useCallback(
    async (tag: Tag): Promise<void> => {
      try {
        await api.tag.delete(tag.id);
        await tags.refetch();
        toast.success(`Deleted ${tag.name}`);
      } catch {
        toast.error("Failed to delete tag");
      }
    },
    [tags.refetch]
  );

  return {
    deleteProject,
    deleteTag,
    loadingProjects: projects.isLoading,
    loadingTags: tags.isLoading,
    projects: projects.data,
    tags: tags.data,
    upsertProject,
    upsertTag,
  };
}
