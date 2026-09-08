"use client";

import type { PublicTag } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type WorkflowSearchFilterProps = {
  publicTags?: PublicTag[];
  selectedTagSlugs?: string[];
  onTagToggle?: (slug: string) => void;
};

export function WorkflowSearchFilter({
  publicTags = [],
  selectedTagSlugs = [],
  onTagToggle,
}: WorkflowSearchFilterProps): React.ReactElement | null {
  if (publicTags.length === 0 || !onTagToggle) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {publicTags.map((tag) => {
        const isSelected = selectedTagSlugs.includes(tag.slug);
        return (
          <button
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
              "border focus:outline-none focus:ring-1 focus:ring-[var(--color-text-accent)]/30",
              isSelected
                ? "border-[var(--color-text-accent)]/30 bg-[var(--color-bg-accent)] text-[var(--color-text-accent)]"
                : "border-border/30 text-muted-foreground hover:border-border/60 hover:text-foreground"
            )}
            key={tag.slug}
            onClick={() => onTagToggle(tag.slug)}
            type="button"
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
