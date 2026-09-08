"use client";

import { NamedColorFormDialog } from "@/components/ui/named-color-form-dialog";
import { api, type Project } from "@/lib/api-client";

type ProjectFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
  project?: Project | null;
  onUpdated?: (project: Project) => void;
};

export function ProjectFormDialog({
  open,
  onOpenChange,
  onCreated,
  project,
  onUpdated,
}: ProjectFormDialogProps): React.ReactElement {
  return (
    <NamedColorFormDialog
      descriptionField={{ placeholder: "Brief summary of this project" }}
      entity={project}
      entityLabel="project"
      entityTitle="Project"
      idPrefix="project"
      namePlaceholder="e.g. Sky ESM Monitoring"
      onCreate={({ name, description, color }) =>
        api.project.create({
          name,
          description: description.trim() || undefined,
          color,
        })
      }
      onCreated={onCreated}
      onOpenChange={onOpenChange}
      onUpdate={(current, { name, description, color }) =>
        api.project.update(current.id, {
          name,
          description: description.trim() || undefined,
          color: color ?? undefined,
        })
      }
      onUpdated={onUpdated}
      open={open}
    />
  );
}
