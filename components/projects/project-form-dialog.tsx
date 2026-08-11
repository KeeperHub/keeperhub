"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type Project } from "@/lib/api-client";
import { COLOR_PALETTE } from "@/lib/palette";
import { cn } from "@/lib/utils";

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
}: ProjectFormDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLOR_PALETTE[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isEditing = Boolean(project);

  // Sync the form to the project being edited (or reset for create) each time
  // the dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setColor(project?.color ?? COLOR_PALETTE[0]);
  }, [open, project]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (project) {
        const updated = await api.project.update(project.id, {
          name: trimmed,
          description: description.trim() || undefined,
          color: color ?? undefined,
        });
        onUpdated?.(updated);
      } else {
        const created = await api.project.create({
          name: trimmed,
          description: description.trim() || undefined,
          color,
        });
        onCreated(created);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to ${isEditing ? "update" : "create"} project`
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Project" : "New Project"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  handleSubmit();
                }
              }}
              placeholder="e.g. Sky ESM Monitoring"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Textarea
              id="project-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief summary of this project"
              rows={2}
              value={description}
            />
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex gap-2">
              {COLOR_PALETTE.map((c) => (
                <button
                  className={cn(
                    "size-7 rounded-full border-2 transition-transform hover:scale-110",
                    color === c
                      ? "scale-110 border-foreground"
                      : "border-transparent"
                  )}
                  key={c}
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  type="button"
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || isSubmitting}
            onClick={handleSubmit}
          >
            {isSubmitting && (isEditing ? "Saving..." : "Creating...")}
            {!isSubmitting && (isEditing ? "Save Changes" : "Create Project")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
