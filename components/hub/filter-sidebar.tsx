"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export type FilterSidebarTag = {
  name: string;
  slug: string;
};

type FilterSidebarProps<TSort extends string> = {
  /** aria-label for the <aside> landmark. */
  ariaLabel: string;
  /** aria-label for the sort radiogroup. */
  sortAriaLabel: string;
  sortOptions: ReadonlyArray<{ value: TSort; label: string }>;
  activeSort: TSort;
  onSortChange: (next: TSort) => void;
  tags: readonly FilterSidebarTag[];
  activeTagSlug: string | null;
  /** Builds the href for a tag link (null = the "All" link). */
  buildTagHref: (tagSlug: string | null) => string;
};

type SectionHeaderProps = {
  label: string;
  count?: number;
};

function SectionHeader({
  label,
  count,
}: SectionHeaderProps): React.ReactElement {
  return (
    <CollapsibleTrigger asChild>
      <button
        className="group flex w-full items-center justify-between rounded-md px-3 py-2 font-normal text-muted-foreground text-xs uppercase tracking-widest transition-colors duration-100 hover:bg-[var(--color-hub-icon-bg)]/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none"
        type="button"
      >
        <span className="inline-flex items-center gap-2">
          {label}
          {typeof count === "number" && (
            <span className="font-normal normal-case text-muted-foreground/60 tracking-normal">
              ({count})
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-200 group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
        />
      </button>
    </CollapsibleTrigger>
  );
}

export function FilterSidebar<TSort extends string>({
  ariaLabel,
  sortAriaLabel,
  sortOptions,
  activeSort,
  onSortChange,
  tags,
  activeTagSlug,
  buildTagHref,
}: FilterSidebarProps<TSort>): React.ReactElement {
  // First-paint defaults are owned locally so the navigation-sidebar's
  // global panels.sort/panels.tags state (which both default to "closed"
  // for the nav sidebar UX) does not bleed through. Both sections open by
  // default; the user can collapse them manually within a session.
  const [sortOpen, setSortOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const tagsOverflow = tags.length > 12;

  return (
    <aside
      aria-label={ariaLabel}
      className="hidden w-[240px] shrink-0 flex-col gap-8 rounded-r-xl bg-[var(--color-hub-card)] p-4 shadow-sm lg:flex"
    >
      <Collapsible onOpenChange={setSortOpen} open={sortOpen}>
        <SectionHeader label="Sort" />
        <CollapsibleContent
          aria-label={sortAriaLabel}
          className="flex flex-col gap-1 pt-1 pb-2"
          role="radiogroup"
        >
          {sortOptions.map((opt) => {
            const active = opt.value === activeSort;
            return (
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio pattern on a <button> is the only option that supports rich label markup + click handling without form-association side effects (matches Radix RadioGroupItem).
              <button
                aria-checked={active}
                className={`flex min-h-7 items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
                  active
                    ? "bg-muted font-normal text-foreground"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                key={opt.value}
                onClick={() => onSortChange(opt.value)}
                role="radio"
                tabIndex={active ? 0 : -1}
                type="button"
              >
                {opt.label}
              </button>
            );
          })}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible onOpenChange={setTagsOpen} open={tagsOpen}>
        <SectionHeader count={tags.length} label="Tags" />
        <CollapsibleContent
          className={`flex flex-col gap-0.5 pt-1 pb-2 ${
            tagsOverflow ? "max-h-96 overflow-y-auto" : ""
          }`}
        >
          <Link
            aria-current={activeTagSlug === null ? "page" : undefined}
            className={`flex min-h-7 items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
              activeTagSlug === null
                ? "bg-muted font-normal text-foreground"
                : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            href={buildTagHref(null)}
            prefetch
            scroll={false}
          >
            <span className="truncate">All</span>
          </Link>
          {tags.map((tag) => {
            const active = activeTagSlug === tag.slug;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex min-h-7 items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
                  active
                    ? "bg-muted font-normal text-foreground"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={buildTagHref(tag.slug)}
                key={tag.slug}
                prefetch
                scroll={false}
              >
                <span className="truncate">{tag.name}</span>
              </Link>
            );
          })}
        </CollapsibleContent>
      </Collapsible>
    </aside>
  );
}
