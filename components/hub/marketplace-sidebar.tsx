"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { MarketplaceSort } from "@/lib/marketplace/leaderboard-query";

// Visible sort options. Mirrors the previous MarketplaceSortDropdown.
// Revenue-based sort is EXPLICITLY DEFERRED per MARKET-02 + MARKET-FUTURE-01
// (privacy review pending).
const SORT_OPTIONS: ReadonlyArray<{ value: MarketplaceSort; label: string }> = [
  { value: "popular", label: "Popular" },
  { value: "newest", label: "Newest" },
  { value: "top-calls", label: "Calls" },
  { value: "price", label: "Price" },
  { value: "owner", label: "Owner" },
] as const;

export type MarketplaceSidebarTag = {
  name: string;
  slug: string;
};

type Props = {
  active: MarketplaceSort;
  activeTagSlug: string | null;
  tags: MarketplaceSidebarTag[];
};

function SectionHeader({
  count,
  label,
}: {
  count?: number;
  label: string;
}): React.ReactElement {
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

function buildTagHref(
  currentParams: ReturnType<typeof useSearchParams>,
  tagSlug: string | null
): string {
  // Mirror the marketplace sort writer: pin tab=marketplace, set/delete
  // tag, drop cursor (cursor was paged against the prior filter set).
  // Preserve unrelated params (q, sort).
  const next = new URLSearchParams(currentParams.toString());
  next.set("tab", "marketplace");
  if (tagSlug === null) {
    next.delete("tag");
  } else {
    next.set("tag", tagSlug);
  }
  next.delete("cursor");
  return `/hub?${next.toString()}`;
}

export function MarketplaceSidebar({
  active,
  activeTagSlug,
  tags,
}: Props): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [sortOpen, setSortOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const tagsOverflow = tags.length > 12;

  const handleSelectSort = (value: MarketplaceSort): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "marketplace");
    params.set("sort", value);
    // Reset cursor when sort changes — page 2 of `popular` does not
    // apply to `newest` etc.
    params.delete("cursor");
    startTransition(() => {
      router.replace(`/hub?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <aside
      aria-label="Marketplace filters"
      className="hidden w-[240px] shrink-0 flex-col gap-8 rounded-r-xl bg-[var(--color-hub-card)] p-4 shadow-sm lg:flex"
    >
      <Collapsible onOpenChange={setSortOpen} open={sortOpen}>
        <SectionHeader label="Sort" />
        <CollapsibleContent
          aria-label="Sort marketplace by"
          className="flex flex-col gap-1 pt-1 pb-2"
          role="radiogroup"
        >
          {SORT_OPTIONS.map((opt) => {
            const isActive = opt.value === active;
            return (
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio pattern on a <button> matches HubSidebar's Sort section for visual + interaction parity.
              <button
                aria-checked={isActive}
                className={`flex min-h-7 items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
                  isActive
                    ? "bg-muted font-normal text-foreground"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                key={opt.value}
                onClick={() => handleSelectSort(opt.value)}
                role="radio"
                tabIndex={isActive ? 0 : -1}
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
            href={buildTagHref(searchParams, null)}
            prefetch
            scroll={false}
          >
            <span className="truncate">All</span>
          </Link>
          {tags.map((tag) => {
            const isActive = activeTagSlug === tag.slug;
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-7 items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] motion-reduce:transition-none ${
                  isActive
                    ? "bg-muted font-normal text-foreground"
                    : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                href={buildTagHref(searchParams, tag.slug)}
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
