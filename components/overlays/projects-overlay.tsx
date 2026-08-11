"use client";

import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { api, type Project } from "@/lib/api-client";

type ProjectsOverlayProps = {
  overlayId: string;
};

export function ProjectsOverlay({ overlayId }: ProjectsOverlayProps) {
  const { open: openOverlay } = useOverlay();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.project.getAll();
      setProjects(result);
    } catch {
      toast.error("Failed to load projects");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleDelete = (project: Project) => {
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

  const handleProjectCreated = (project: Project) => {
    setProjects((prev) => [...prev, project]);
  };

  return (
    <>
      <Overlay
        description="Manage your workflow projects"
        overlayId={overlayId}
        title="Projects"
      >
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowCreateDialog(true)} size="sm">
              <Plus className="mr-2 size-4" />
              New Project
            </Button>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          )}
          {!isLoading && projects.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <FolderOpen className="size-8" />
              <p className="text-sm">No projects yet</p>
              <p className="text-xs">
                Create a project to organize your workflows.
              </p>
            </div>
          )}
          {!isLoading && projects.length > 0 && (
            <div className="space-y-1">
              {projects.map((project) => (
                <div
                  className="flex items-center justify-between rounded-md border px-4 py-3"
                  key={project.id}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-block size-3 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          project.color ?? "var(--color-text-muted)",
                      }}
                    />
                    <div>
                      <p className="font-medium text-sm">{project.name}</p>
                      {project.description && (
                        <p className="text-muted-foreground text-xs">
                          {project.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground text-xs">
                      {project.workflowCount}{" "}
                      {project.workflowCount === 1 ? "workflow" : "workflows"}
                    </span>
                    {project.workflowCount === 0 && (
                      <Button
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(project)}
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
        </div>
      </Overlay>
      <ProjectFormDialog
        onCreated={handleProjectCreated}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />
    </>
  );
}
