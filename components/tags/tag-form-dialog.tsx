"use client";

import { NamedColorFormDialog } from "@/components/ui/named-color-form-dialog";
import { api, type Tag } from "@/lib/api-client";

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
}: TagFormDialogProps): React.ReactElement {
  return (
    <NamedColorFormDialog
      entity={tag}
      entityLabel="tag"
      entityTitle="Tag"
      idPrefix="tag"
      namePlaceholder="e.g. Production, Monitoring, DeFi"
      onCreate={({ name, color }) => api.tag.create({ name, color })}
      onCreated={onCreated}
      onOpenChange={onOpenChange}
      onUpdate={(current, { name, color }) =>
        api.tag.update(current.id, { name, color })
      }
      onUpdated={onUpdated}
      open={open}
    />
  );
}
