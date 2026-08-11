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
import { api, type Tag } from "@/lib/api-client";
import { COLOR_PALETTE } from "@/lib/palette";
import { cn } from "@/lib/utils";

type TagFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (tag: Tag) => void;
  tag?: Tag | null;
  onUpdated?: (tag: Tag) => void;
};

export function TagFormDialog({
  open,
  onOpenChange,
  onCreated,
  tag,
  onUpdated,
}: TagFormDialogProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLOR_PALETTE[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isEditing = Boolean(tag);

  // Sync the form to the tag being edited (or reset for create) each time the
  // dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(tag?.name ?? "");
    setColor(tag?.color ?? COLOR_PALETTE[0]);
  }, [open, tag]);

  const handleSubmit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (tag) {
        const updated = await api.tag.update(tag.id, {
          name: trimmed,
          color,
        });
        onUpdated?.(updated);
      } else {
        const created = await api.tag.create({ name: trimmed, color });
        onCreated(created);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to ${isEditing ? "update" : "create"} tag`
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Tag" : "New Tag"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  handleSubmit();
                }
              }}
              placeholder="e.g. Production, Monitoring, DeFi"
              value={name}
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
            {!isSubmitting && (isEditing ? "Save Changes" : "Create Tag")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
