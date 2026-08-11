"use client";

import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type PublicTag } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type PublicTagSelectorProps = {
  selectedTags: PublicTag[];
  orgTagNames: string[];
  initialTags?: PublicTag[];
  onTagsChange: (tags: PublicTag[]) => void;
};

const MAX_TAGS = 5;

export function PublicTagSelector({
  selectedTags,
  orgTagNames,
  initialTags = [],
  onTagsChange,
}: PublicTagSelectorProps) {
  const [allPublicTags, setAllPublicTags] = useState<PublicTag[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    api.publicTag
      .getAll()
      .then((tags) => {
        // Merge initial tags into the fetched list so they appear even if the fetch is stale
        const merged = [...tags];
        for (const t of initialTags) {
          if (!merged.some((m) => m.id === t.id)) {
            merged.push(t);
          }
        }
        setAllPublicTags(merged);
      })
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional silent catch for non-critical tag fetch
      .catch(() => {});
  }, [initialTags]);

  const selectedIds = new Set(selectedTags.map((t) => t.id));

  const filteredTags = useMemo(() => {
    const query = inputValue.trim().toLowerCase();
    if (!query) {
      return allPublicTags.filter((t) => !selectedIds.has(t.id));
    }
    return allPublicTags.filter(
      (t) => !selectedIds.has(t.id) && t.name.toLowerCase().includes(query)
    );
  }, [allPublicTags, inputValue, selectedIds]);

  const exactMatch = allPublicTags.find(
    (t) => t.name.toLowerCase() === inputValue.trim().toLowerCase()
  );
  const showCreateOption =
    inputValue.trim() && !exactMatch && selectedTags.length < MAX_TAGS;

  const orgSuggestions = orgTagNames.filter(
    (name) =>
      !selectedTags.some((t) => t.name.toLowerCase() === name.toLowerCase())
  );

  const addTag = (tag: PublicTag): void => {
    if (selectedTags.length >= MAX_TAGS) {
      return;
    }
    onTagsChange([...selectedTags, tag]);
    setInputValue("");
  };

  const removeTag = (tagId: string): void => {
    onTagsChange(selectedTags.filter((t) => t.id !== tagId));
  };

  const handleCreateTag = async (name: string): Promise<void> => {
    if (isCreating || selectedTags.length >= MAX_TAGS) {
      return;
    }
    setIsCreating(true);
    try {
      const tag = await api.publicTag.create({ name: name.trim() });
      setAllPublicTags((prev) => {
        if (prev.some((t) => t.id === tag.id)) {
          return prev;
        }
        return [...prev, tag];
      });
      addTag(tag);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOrgTagClick = async (name: string): Promise<void> => {
    const existing = allPublicTags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      addTag(existing);
      return;
    }
    await handleCreateTag(name);
  };

  return (
    <div className="space-y-4">
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary text-xs"
              key={tag.id}
            >
              {tag.name}
              <button
                aria-label={`Remove ${tag.name}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
                onClick={() => removeTag(tag.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <input
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50"
          disabled={selectedTags.length >= MAX_TAGS}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={
            selectedTags.length >= MAX_TAGS
              ? "Maximum tags reached"
              : "Search or create tags..."
          }
          type="text"
          value={inputValue}
        />

        {(filteredTags.length > 0 || showCreateOption) && (
          <div className="flex flex-wrap gap-1.5">
            {filteredTags.slice(0, 10).map((tag) => (
              <button
                className={cn(
                  "rounded-full border border-border px-2.5 py-1 text-xs transition-colors",
                  "bg-muted text-foreground/70 hover:bg-muted/80 hover:text-foreground"
                )}
                key={tag.id}
                onClick={() => addTag(tag)}
                type="button"
              >
                {tag.name}
              </button>
            ))}
            {showCreateOption && (
              <button
                className="rounded-full border border-primary/50 border-dashed px-2.5 py-1 text-primary text-xs transition-colors hover:border-primary hover:bg-primary/10"
                disabled={isCreating}
                onClick={() => handleCreateTag(inputValue)}
                type="button"
              >
                {isCreating ? "Creating..." : `Create "${inputValue.trim()}"`}
              </button>
            )}
          </div>
        )}
      </div>

      {orgSuggestions.length > 0 && (
        <div>
          <p className="mb-2 text-muted-foreground text-sm">
            From your organization
          </p>
          <div className="flex flex-wrap gap-1.5">
            {orgSuggestions.map((name) => (
              <button
                className={cn(
                  "rounded-full border border-border px-2.5 py-1 text-xs transition-colors",
                  "bg-muted text-foreground/70 hover:bg-muted/80 hover:text-foreground",
                  selectedTags.length >= MAX_TAGS &&
                    "cursor-not-allowed opacity-50"
                )}
                disabled={selectedTags.length >= MAX_TAGS}
                key={name}
                onClick={() => handleOrgTagClick(name)}
                type="button"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {selectedTags.length}/{MAX_TAGS} tags selected
      </p>
    </div>
  );
}
