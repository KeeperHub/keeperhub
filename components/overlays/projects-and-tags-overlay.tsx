"use client";

import {
  FolderOpen,
  History,
  Pencil,
  Plus,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { ResourceActivityOverlay } from "@/components/overlays/resource-activity-overlay";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { TagFormDialog } from "@/components/tags/tag-form-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type Project, type Tag as TagType } from "@/lib/api-client";
import { useActiveMember } from "@/lib/hooks/use-organization";

type ProjectsAndTagsOverlayProps = {
  overlayId: string;
  initialTab?: "projects" | "tags";
};

export function ProjectsAndTagsOverlay({
  overlayId,
  initialTab = "projects",
}: ProjectsAndTagsOverlayProps): React.ReactElement {
  const { open: openOverlay, push } = useOverlay();
  const { isAdmin } = useActiveMember();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<TagType[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingTags, setLoadingTags] = useState(true);
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showTagDialog, setShowTagDialog] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTag, setEditingTag] = useState<TagType | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const result = await api.project.getAll();
      setProjects(result);
    } catch {
      toast.error("Failed to load projects");
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const result = await api.tag.getAll();
      setTags(result);
    } catch {
      toast.error("Failed to load tags");
    } finally {
      setLoadingTags(false);
    }
  }, []);

  useEffect(() => {
    loadProjects().catch(() => undefined);
    loadTags().catch(() => undefined);
  }, [loadProjects, loadTags]);

  const handleDeleteProject = (project: Project): void => {
    openOverlay(ConfirmOverlay, {
      title: "Delete Project",
      message: `Are you sure you want to delete "${project.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        try {
          await api.project.delete(project.id);
          setProjects((prev) => prev.filter((p) => p.id !== project.id));
          toast.success(`Project "${project.name}" deleted`);
        } catch {
          toast.error("Failed to delete project");
        }
      },
    });
  };

  const handleDeleteTag = (tag: TagType): void => {
    openOverlay(ConfirmOverlay, {
      title: "Delete Tag",
      message: `Are you sure you want to delete "${tag.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        try {
          await api.tag.delete(tag.id);
          setTags((prev) => prev.filter((t) => t.id !== tag.id));
          toast.success(`Tag "${tag.name}" deleted`);
        } catch {
          toast.error("Failed to delete tag");
        }
      },
    });
  };

  const handleProjectCreated = (project: Project): void => {
    setProjects((prev) => [...prev, project]);
  };

  const handleTagCreated = (tag: TagType): void => {
    setTags((prev) => [...prev, tag]);
  };

  const handleProjectUpdated = (project: Project): void => {
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, ...project } : p))
    );
    toast.success(`Project "${project.name}" updated`);
  };

  const handleTagUpdated = (tag: TagType): void => {
    setTags((prev) =>
      prev.map((t) => (t.id === tag.id ? { ...t, ...tag } : t))
    );
    toast.success(`Tag "${tag.name}" updated`);
  };

  const openEditProject = (project: Project): void => {
    setEditingProject(project);
    setShowProjectDialog(true);
  };

  const openEditTag = (tag: TagType): void => {
    setEditingTag(tag);
    setShowTagDialog(true);
  };

  const openNewProject = (): void => {
    setEditingProject(null);
    setShowProjectDialog(true);
  };

  const openNewTag = (): void => {
    setEditingTag(null);
    setShowTagDialog(true);
  };

  return (
    <>
      <Overlay
        description="Organize and categorize your workflows"
        overlayId={overlayId}
        title="Projects and Tags"
      >
        <Tabs className="w-full" defaultValue={initialTab}>
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="tags">Tags</TabsTrigger>
          </TabsList>

          <TabsContent className="space-y-4" value="projects">
            <div className="flex justify-end">
              <Button onClick={openNewProject} size="sm">
                <Plus className="mr-2 size-4" />
                New Project
              </Button>
            </div>

            {loadingProjects && (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            )}
            {!loadingProjects && projects.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                <FolderOpen className="size-8" />
                <p className="text-sm">No projects yet</p>
                <p className="text-xs">
                  Create a project to organize your workflows.
                </p>
              </div>
            )}
            {!loadingProjects && projects.length > 0 && (
              <div className="space-y-1">
                {projects.map((project) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border px-4 py-3"
                    key={project.id}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            project.color ?? "var(--color-text-muted)",
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-sm">
                          {project.name}
                        </p>
                        {project.description && (
                          <p className="break-words text-muted-foreground text-xs">
                            {project.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="whitespace-nowrap text-muted-foreground text-xs">
                        {project.workflowCount}{" "}
                        {project.workflowCount === 1
                          ? "workflow"
                          : "workflows"}
                      </span>
                      {isAdmin && (
                        <Button
                          className="text-muted-foreground"
                          onClick={() => openEditProject(project)}
                          size="icon"
                          title="Edit project"
                          variant="ghost"
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {isAdmin && (
                        <Button
                          className="text-muted-foreground"
                          onClick={() =>
                            push(ResourceActivityOverlay, {
                              title: `Activity: ${project.name}`,
                              resourceType: "project",
                              resourceId: project.id,
                              createdAction: "project.created",
                              createdAt: project.createdAt,
                              creator: {
                                name: project.createdByName ?? null,
                                email: project.createdByEmail ?? null,
                                role: project.createdByRole ?? null,
                              },
                            })
                          }
                          size="icon"
                          title="View activity"
                          variant="ghost"
                        >
                          <History className="size-4" />
                        </Button>
                      )}
                      {project.workflowCount === 0 && (
                        <Button
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteProject(project)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent className="space-y-4" value="tags">
            <div className="flex justify-end">
              <Button onClick={openNewTag} size="sm">
                <Plus className="mr-2 size-4" />
                New Tag
              </Button>
            </div>

            {loadingTags && (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            )}
            {!loadingTags && tags.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                <TagIcon className="size-8" />
                <p className="text-sm">No tags yet</p>
                <p className="text-xs">
                  Create a tag to categorize your workflows.
                </p>
              </div>
            )}
            {!loadingTags && tags.length > 0 && (
              <div className="space-y-1">
                {tags.map((tag) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border px-4 py-3"
                    key={tag.id}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <p className="truncate font-medium text-sm">{tag.name}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="whitespace-nowrap text-muted-foreground text-xs">
                        {tag.workflowCount}{" "}
                        {tag.workflowCount === 1 ? "workflow" : "workflows"}
                      </span>
                      {isAdmin && (
                        <Button
                          className="text-muted-foreground"
                          onClick={() => openEditTag(tag)}
                          size="icon"
                          title="Edit tag"
                          variant="ghost"
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {isAdmin && (
                        <Button
                          className="text-muted-foreground"
                          onClick={() =>
                            push(ResourceActivityOverlay, {
                              title: `Activity: ${tag.name}`,
                              resourceType: "tag",
                              resourceId: tag.id,
                              createdAction: "tag.created",
                              createdAt: tag.createdAt,
                              creator: {
                                name: tag.createdByName ?? null,
                                email: tag.createdByEmail ?? null,
                                role: tag.createdByRole ?? null,
                              },
                            })
                          }
                          size="icon"
                          title="View activity"
                          variant="ghost"
                        >
                          <History className="size-4" />
                        </Button>
                      )}
                      {tag.workflowCount === 0 && (
                        <Button
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteTag(tag)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Overlay>
      <ProjectFormDialog
        onCreated={handleProjectCreated}
        onOpenChange={setShowProjectDialog}
        onUpdated={handleProjectUpdated}
        open={showProjectDialog}
        project={editingProject}
      />
      <TagFormDialog
        onCreated={handleTagCreated}
        onOpenChange={setShowTagDialog}
        onUpdated={handleTagUpdated}
        open={showTagDialog}
        tag={editingTag}
      />
    </>
  );
}
