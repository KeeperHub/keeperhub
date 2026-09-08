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
import { COLOR_PALETTE } from "@/lib/palette";
import { cn } from "@/lib/utils";

type NamedColorEntity = {
  name: string;
  color?: string | null;
  description?: string | null;
};

export type NamedColorFormInput = {
  /** Trimmed, non-empty name. */
  name: string;
  /** Raw description field value ("" when the field is not rendered). */
  description: string;
  color: string;
};

type NamedColorFormDialogProps<T extends NamedColorEntity> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (entity: T) => void;
  /** Entity being edited; null/undefined switches the dialog to create mode. */
  entity?: T | null;
  onUpdated?: (entity: T) => void;
  /** Capitalized noun for titles and buttons, e.g. "Project". */
  entityTitle: string;
  /** Lowercase noun for the error toast, e.g. "project". */
  entityLabel: string;
  /** Prefix for input element ids, e.g. "project" -> "project-name". */
  idPrefix: string;
  namePlaceholder: string;
  /** When set, renders the optional description textarea. */
  descriptionField?: { placeholder: string };
  onCreate: (input: NamedColorFormInput) => Promise<T>;
  onUpdate: (entity: T, input: NamedColorFormInput) => Promise<T>;
};

export function NamedColorFormDialog<T extends NamedColorEntity>({
  open,
  onOpenChange,
  onCreated,
  entity,
  onUpdated,
  entityTitle,
  entityLabel,
  idPrefix,
  namePlaceholder,
  descriptionField,
  onCreate,
  onUpdate,
}: NamedColorFormDialogProps<T>): React.ReactElement {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLOR_PALETTE[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isEditing = Boolean(entity);

  // Sync the form to the entity being edited (or reset for create) each time
  // the dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(entity?.name ?? "");
    setDescription(entity?.description ?? "");
    setColor(entity?.color ?? COLOR_PALETTE[0]);
  }, [open, entity]);

  const handleSubmit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    setIsSubmitting(true);
    try {
      const input: NamedColorFormInput = { name: trimmed, description, color };
      if (entity) {
        const updated = await onUpdate(entity, input);
        onUpdated?.(updated);
      } else {
        const created = await onCreate(input);
        onCreated(created);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to ${isEditing ? "update" : "create"} ${entityLabel}`
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
            {isEditing ? `Edit ${entityTitle}` : `New ${entityTitle}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-name`}>Name</Label>
            <Input
              id={`${idPrefix}-name`}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  handleSubmit();
                }
              }}
              placeholder={namePlaceholder}
              value={name}
            />
          </div>
          {descriptionField && (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-description`}>
                Description (optional)
              </Label>
              <Textarea
                id={`${idPrefix}-description`}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={descriptionField.placeholder}
                rows={2}
                value={description}
              />
            </div>
          )}
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
            {!isSubmitting &&
              (isEditing ? "Save Changes" : `Create ${entityTitle}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
