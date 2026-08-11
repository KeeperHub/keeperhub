"use client";

import { Plus, Tag, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TagFormDialog } from "@/components/tags/tag-form-dialog";
import { api, type Tag as TagType } from "@/lib/api-client";

type TagsOverlayProps = {
  overlayId: string;
};

export function TagsOverlay({ overlayId }: TagsOverlayProps) {
  const { open: openOverlay } = useOverlay();
  const [tags, setTags] = useState<TagType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      const result = await api.tag.getAll();
      setTags(result);
    } catch {
      toast.error("Failed to load tags");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const handleDelete = (tag: TagType): void => {
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

  const handleTagCreated = (tag: TagType): void => {
    setTags((prev) => [...prev, tag]);
  };

  return (
    <>
      <Overlay
        description="Manage your workflow tags"
        overlayId={overlayId}
        title="Tags"
      >
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowCreateDialog(true)} size="sm">
              <Plus className="mr-2 size-4" />
              New Tag
            </Button>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          )}
          {!isLoading && tags.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <Tag className="size-8" />
              <p className="text-sm">No tags yet</p>
              <p className="text-xs">
                Create a tag to categorize your workflows.
              </p>
            </div>
          )}
          {!isLoading && tags.length > 0 && (
            <div className="space-y-1">
              {tags.map((tag) => (
                <div
                  className="flex items-center justify-between rounded-md border px-4 py-3"
                  key={tag.id}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-block size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <p className="font-medium text-sm">{tag.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground text-xs">
                      {tag.workflowCount}{" "}
                      {tag.workflowCount === 1 ? "workflow" : "workflows"}
                    </span>
                    {tag.workflowCount === 0 && (
                      <Button
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(tag)}
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
      <TagFormDialog
        onCreated={handleTagCreated}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />
    </>
  );
}
