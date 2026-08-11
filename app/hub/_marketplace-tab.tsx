import { asc, eq } from "drizzle-orm";
import { Box, X } from "lucide-react";
import Link from "next/link";
import { MarketplaceRow } from "@/components/hub/marketplace-row";
import {
  MarketplaceSidebar,
  type MarketplaceSidebarTag,
} from "@/components/hub/marketplace-sidebar";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { publicTags, workflowPublicTags } from "@/lib/db/schema-extensions";
import {
  fetchMarketplaceLeaderboard,
  type MarketplaceSort,
} from "@/lib/marketplace/leaderboard-query";
import { readOwnerParam } from "@/lib/marketplace/read-search-params";

const VALID_SORTS: readonly MarketplaceSort[] = [
  "popular",
  "newest",
  "top-calls",
  "price",
  "owner",
];

async function fetchMarketplaceTags(): Promise<MarketplaceSidebarTag[]> {
  // Only surface tags that are actually used by listed workflows.
  // Showing the full public_tags taxonomy would mix in workflow-template
  // tags that have no marketplace presence (and would always return zero
  // results when clicked).
  try {
    return await db
      .selectDistinct({ name: publicTags.name, slug: publicTags.slug })
      .from(publicTags)
      .innerJoin(
        workflowPublicTags,
        eq(workflowPublicTags.publicTagId, publicTags.id)
      )
      .innerJoin(workflows, eq(workflows.id, workflowPublicTags.workflowId))
      .where(eq(workflows.isListed, true))
      .orderBy(asc(publicTags.name));
  } catch {
    return [];
  }
}

// Slugs are kebab-case `[a-z0-9-]` per HUB-15 / reserved-slugs and
// pubic_tags.slug schema. Bound length to prevent unstable_cache key
// pollution via `?tag=<random>` spam (each unique value = a fresh DB
// hit before the cache gates).
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

function readTag(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return SLUG_PATTERN.test(raw) ? raw : null;
}

function readSort(raw: string | string[] | undefined): MarketplaceSort {
  if (typeof raw !== "string") {
    return "popular";
  }
  const lower = raw.toLowerCase();
  return (VALID_SORTS as readonly string[]).includes(lower)
    ? (lower as MarketplaceSort)
    : "popular";
}

function readCursor(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

type MarketplaceTabProps = {
  searchParams: Record<string, string | string[] | undefined>;
  query: string;
};

export async function HubMarketplaceTab({
  searchParams,
  query,
}: MarketplaceTabProps): Promise<React.ReactElement> {
  const sort = readSort(searchParams.sort);
  const cursor = readCursor(searchParams.cursor);
  const tagSlug = readTag(searchParams.tag);
  const ownerName = readOwnerParam(searchParams.owner);
  const [{ rows, total }, tags] = await Promise.all([
    fetchMarketplaceLeaderboard(sort, cursor, query, tagSlug, ownerName),
    fetchMarketplaceTags(),
  ]);

  const hasQuery = query.trim().length > 0;
  const hasFilter = hasQuery || tagSlug !== null || ownerName !== null;
  const emptyHeading = (() => {
    if (hasQuery) {
      return `No marketplace services match “${query}”.`;
    }
    if (ownerName !== null) {
      return `No marketplace services listed by ${ownerName}.`;
    }
    if (hasFilter) {
      return "No marketplace services match this filter.";
    }
    return "No paid services listed yet.";
  })();
  // Clear-filters target preserves sort (sort is a view choice, not a
  // filter) and tab. Drops q, tag, cursor, owner.
  const clearFiltersHref = `/hub?tab=marketplace&sort=${sort}`;
  // Owner-only clear: drops owner + cursor (cursor was paged against the
  // owner-filtered set). Preserves q, tag, sort so a search/tag pair
  // survives clearing just the owner pill.
  const clearOwnerHref = (() => {
    const params = new URLSearchParams();
    params.set("tab", "marketplace");
    params.set("sort", sort);
    if (query.trim() !== "") {
      params.set("q", query.trim());
    }
    if (tagSlug !== null) {
      params.set("tag", tagSlug);
    }
    return `/hub?${params.toString()}`;
  })();

  return (
    // Top spacer mirrors the height of the Workflows tab's view-toggle row
    // (HubViewToggle is h-9 + mb-4 = 52px). Marketplace doesn't have a
    // cards/list toggle yet, but reserving the same vertical space keeps
    // table content from jumping when the user switches between tabs.
    <>
      <div aria-hidden="true" className="mb-4 h-9" />
      <section aria-label="Marketplace results" className="flex gap-6">
        <MarketplaceSidebar active={sort} activeTagSlug={tagSlug} tags={tags} />
        <div className="relative min-w-0 flex-1">
          {ownerName !== null && (
            // Absolutely positioned into the always-reserved top spacer
            // (mb-4 h-9 above) so toggling the owner filter doesn't shift
            // the table down. -top-9 (-36px) sits the pill near the bottom
            // of the spacer so the visible gap to the table matches the
            // pre-overlay mb-3 layout (~12px between pill and table top).
            <div className="-top-9 absolute right-0 left-0 flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Filtered by owner:</span>
              <Link
                aria-label={`Clear owner filter ${ownerName}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground/10 px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-foreground/15 motion-reduce:transition-none"
                href={clearOwnerHref}
                scroll={false}
              >
                <span className="max-w-[16rem] truncate">{ownerName}</span>
                <X aria-hidden="true" className="size-3" />
              </Link>
            </div>
          )}
          {rows.length === 0 ? (
            <section
              aria-label="No marketplace results"
              className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
            >
              <Box
                aria-hidden="true"
                className="size-8 text-muted-foreground/50"
              />
              <h2 className="mt-4 font-semibold text-foreground text-sm">
                {emptyHeading}
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                {hasFilter
                  ? "Try a different keyword or clear the filter."
                  : "Listed workflows show up here once they have payment activity. List a workflow from your workflow toolbar to get started."}
              </p>
              {hasFilter && (
                <Button asChild className="mt-4 h-8 text-xs" variant="outline">
                  <Link href={clearFiltersHref} scroll={false}>
                    Clear filters
                  </Link>
                </Button>
              )}
            </section>
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: UI-SPEC §5 mandates a CSS grid layout (grid-cols-[48px_1fr_140px_100px_72px_88px_64px]); a native <table> cannot drive grid tracks. The role="table"/"row"/"columnheader" hierarchy preserves screen-reader semantics.
            <div
              aria-label="Marketplace leaderboard"
              aria-rowcount={total}
              className="overflow-hidden rounded-xl border border-border/20 bg-[var(--color-hub-card)]"
              role="table"
            >
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: the header row is a label container, not a tab stop; making it focusable would create empty stops in the keyboard order. */}
              <div
                className="grid grid-cols-[48px_1fr_140px_100px_72px_88px_64px] items-center gap-x-3 border-border/30 border-b bg-[var(--color-hub-overlay)] px-4 py-3 font-normal text-muted-foreground text-xs uppercase tracking-widest"
                role="row"
              >
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels; focusable headers would clutter keyboard order without adding navigation value. */}
                <span role="columnheader">Rank</span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span role="columnheader">Name</span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span
                  className="hidden justify-self-end lg:inline"
                  role="columnheader"
                >
                  Tags
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span
                  className="hidden justify-self-end md:inline"
                  role="columnheader"
                >
                  Owner
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span className="justify-self-end" role="columnheader">
                  Calls
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span className="justify-self-end" role="columnheader">
                  Price
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
                {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
                <span
                  className="hidden justify-self-end md:inline"
                  role="columnheader"
                >
                  Chain
                </span>
              </div>
              {rows.map((row, idx) => (
                <MarketplaceRow key={row.workflowId} rank={idx + 1} row={row} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
