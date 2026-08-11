"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { PublicTag } from "@/lib/api-client";

export type SortValue = "most-used" | "featured" | "top-rated" | "name";

type HubSidebarProps = {
  publicTags: PublicTag[];
  sortBy: SortValue;
  onSortChange: (next: SortValue) => void;
  /**
   * Slug of the currently-active tag filter (driven by ?tag= query param).
   * Null when no tag filter is active.
   */
  activeTagSlug: string | null;
};

const SORT_OPTIONS: ReadonlyArray<{ value: SortValue; label: string }> = [
  { value: "top-rated", label: "Top rated" },
  { value: "most-used", label: "Most used" },
  { value: "featured", label: "Featured" },
  { value: "name", label: "Name" },
] as const;

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

function buildHref(
  currentParams: ReturnType<typeof useSearchParams>,
  tagSlug: string | null
): string {
  // Sidebar is mounted only inside the Workflows tab — the tabbed-hub URL
  // contract requires `tab=workflows` on every link out of the sidebar so
  // /hub doesn't bounce back to the default Protocols tab. Preserve any
  // unrelated query params the user is carrying (e.g. ?q=).
  const next = new URLSearchParams(currentParams.toString());
  next.set("tab", "workflows");
  if (tagSlug === null) {
    next.delete("tag");
  } else {
    next.set("tag", tagSlug);
  }
  return `/hub?${next.toString()}`;
}

export function HubSidebar({
  publicTags,
  sortBy,
  onSortChange,
  activeTagSlug,
}: HubSidebarProps): React.ReactElement {
  const searchParams = useSearchParams();
  // First-paint defaults are owned locally so the navigation-sidebar's
  // global panels.sort/panels.tags state (which both default to "closed"
  // for the nav sidebar UX) does not bleed through to the Hub sidebar.
  // HubSidebar always opens both sections by default; the user can collapse
  // them manually within a session.
  const [sortOpen, setSortOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const tagsOverflow = publicTags.length > 12;

  return (
    <aside
      aria-label="Hub filters"
      className="hidden w-[240px] shrink-0 flex-col gap-8 rounded-r-xl bg-[var(--color-hub-card)] p-4 shadow-sm lg:flex"
    >
      <Collapsible onOpenChange={setSortOpen} open={sortOpen}>
        <SectionHeader label="Sort" />
        <CollapsibleContent
          aria-label="Sort templates by"
          className="flex flex-col gap-1 pt-1 pb-2"
          role="radiogroup"
        >
          {SORT_OPTIONS.map((opt) => {
            const active = opt.value === sortBy;
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
        <SectionHeader count={publicTags.length} label="Tags" />
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
            href={buildHref(searchParams, null)}
            prefetch
            scroll={false}
          >
            <span className="truncate">All</span>
          </Link>
          {publicTags.map((tag) => {
            const active = activeTagSlug === tag.slug;
            // Sidebar tag links stay on /hub and use ?tag= for smooth
            // in-place filtering (no segment change, no shell remount).
            // The /hub/tags/[tag] canonical route still exists for SEO.
            const href = buildHref(searchParams, tag.slug);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex min-h-7 items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
                  active
                    ? "bg-muted font-normal text-foreground"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={href}
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
