"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Tag } from "@/lib/api-client";
import { TagFormDialog } from "./tag-form-dialog";

const NONE_VALUE = "__none__";
const NEW_VALUE = "__new__";

type TagSelectProps = {
  value: string | null;
  onChange: (tagId: string | null) => void;
  disabled?: boolean;
};

export function TagSelect({ value, onChange, disabled }: TagSelectProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      const result = await api.tag.getAll();
      setTags(result);
    } catch {
      // silently fail - tags are optional
    }
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const handleValueChange = (val: string): void => {
    if (val === NEW_VALUE) {
      setShowCreateDialog(true);
      return;
    }
    onChange(val === NONE_VALUE ? null : val);
  };

  const handleTagCreated = (tag: Tag): void => {
    setTags((prev) => [...prev, tag]);
    onChange(tag.id);
  };

  return (
    <>
      <Select
        disabled={disabled}
        onValueChange={handleValueChange}
        value={value ?? NONE_VALUE}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select tag..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {tags.map((tag) => (
            <SelectItem key={tag.id} value={tag.id}>
              <span className="flex items-center gap-2">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={NEW_VALUE}>
            <span className="flex items-center gap-2">
              <Plus className="size-3.5" />
              New Tag
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      <TagFormDialog
        onCreated={handleTagCreated}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />
    </>
  );
}
