"use client";

import { Copy } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, useTransition } from "react";
import { toast } from "sonner";
import { MarketplaceListingOverlay } from "@/components/overlays/marketplace-listing-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MarketplaceLeaderboardRow } from "@/lib/marketplace/leaderboard-query";

type MarketplaceRowProps = {
  row: MarketplaceLeaderboardRow;
  rank: number;
};

function priceLabel(raw: string | null): string {
  if (raw === null || raw === "") {
    return "";
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return "";
  }
  if (num === 0) {
    return "Free";
  }
  return `$${num.toFixed(2)}/call`;
}

function callCountLabel(count: number): string {
  return count.toLocaleString("en-US");
}

type ChainBadge = { label: string } | null;

function chainBadge(chain: string | null): ChainBadge {
  if (chain === null) {
    return null;
  }
  const lower = chain.toLowerCase();
  if (lower === "base" || lower === "8453") {
    return { label: "Base" };
  }
  if (lower === "tempo") {
    return { label: "Tempo" };
  }
  return null;
}

// Marketplace row click opens the listing overlay with the full description,
// tags, price, chain, and calls. The leaderboard intentionally does NOT expose
// the underlying workflow graph; the modal is the public surface for
// marketplace listings.
export function MarketplaceRow({
  row,
  rank,
}: MarketplaceRowProps): React.ReactElement {
  const { open } = useOverlay();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const badge = chainBadge(row.chain);
  const price = priceLabel(row.priceUsdcPerCall);
  const ownerName = row.organizationName;
  const isOwnerClickable = ownerName !== null && ownerName.trim() !== "";

  const openModal = (): void => {
    open(MarketplaceListingOverlay, {
      displayName: row.displayName,
      description: row.description,
      organizationName: row.organizationName,
      tags: row.tags,
      callCount: row.callCount,
      priceLabel: price,
      chainLabel: badge?.label ?? null,
      inputSchema: row.inputSchema,
      outputMapping: row.outputMapping,
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget) {
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openModal();
    }
  };

  const copySlug = async (e: MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation();
    if (!row.listedSlug) {
      return;
    }
    await navigator.clipboard.writeText(row.listedSlug);
    toast.success(`Copied ${row.listedSlug}`);
  };

  // Owner click: filter the marketplace to that organization. Mirrors the
  // sort writer's pattern in marketplace-sidebar.tsx — pin tab=marketplace,
  // set owner, drop cursor (cursor was paged against the unfiltered set).
  // Also drop q + tag so the filter lands on a clean owner-only view; the
  // active-owner pill in _marketplace-tab.tsx provides the clear affordance.
  const filterByOwner = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    if (!isOwnerClickable) {
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "marketplace");
    params.set("owner", ownerName);
    params.delete("cursor");
    params.delete("q");
    params.delete("tag");
    startTransition(() => {
      router.replace(`/hub?${params.toString()}`, { scroll: false });
    });
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: row is structurally a grid <article role="row"> per UI-SPEC §5; the surrounding <div role="table"> demands matching role children, and a wrapping <button> would break the rowgroup hierarchy.
    <article
      aria-label={`Open ${row.displayName}`}
      className="group relative grid min-h-[3rem] cursor-pointer grid-cols-[48px_1fr_140px_100px_72px_88px_64px] items-center gap-x-3 border-border/20 border-b bg-[var(--color-hub-card)] px-4 py-3 transition-colors duration-100 ease before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-[''] last:border-b-0 even:bg-[var(--color-hub-overlay)] hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none"
      onClick={openModal}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: UI-SPEC §5 mandates <article role="row"> for the grid layout; click is delivered via the ::before overlay and onKeyDown handler.
      role="row"
      tabIndex={0}
    >
      <span className="pointer-events-none relative z-[2] font-semibold text-muted-foreground text-sm tabular-nums">
        #{rank}
      </span>

      <div className="pointer-events-none relative z-[2] min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-foreground text-sm">
            {row.displayName}
          </span>
          {row.listedSlug ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={`Copy slug ${row.listedSlug}`}
                  className="pointer-events-auto inline-flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground opacity-30 transition-all hover:bg-foreground/10 hover:text-foreground hover:opacity-100 group-hover:opacity-60 motion-reduce:transition-none focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={copySlug}
                  type="button"
                >
                  <Copy className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                className="font-mono text-xs"
                side="right"
                sideOffset={4}
              >
                {row.listedSlug}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {row.description ? (
          // Single-line preview: right-edge fadeout mask signals "there's
          // more, click the row to see it."
          <div className="mt-0.5 overflow-hidden whitespace-nowrap text-muted-foreground/80 text-xs leading-tight [mask-image:linear-gradient(to_right,black_70%,transparent)] [-webkit-mask-image:linear-gradient(to_right,black_70%,transparent)]">
            {row.description}
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none relative z-[2] hidden max-w-full flex-wrap justify-self-end gap-1 lg:flex">
        {row.tags.slice(0, 3).map((tag) => (
          <span
            // Translucent foreground tint instead of the icon-bg token so the
            // pill stays distinct on the row hover background (which shares
            // the icon-bg color and was bleaching the chips into the row).
            className="rounded-full bg-foreground/10 px-2 py-0.5 font-medium text-[0.625rem] text-muted-foreground"
            key={tag}
          >
            {tag}
          </span>
        ))}
      </div>

      {isOwnerClickable ? (
        <button
          aria-label={`Filter marketplace by ${ownerName}`}
          // pointer-events-auto + stopPropagation lift this out of the
          // row's ::before click overlay (the same trick the copy-slug
          // button uses); without it the row's openModal would fire
          // alongside the owner filter.
          className="pointer-events-auto relative z-[2] hidden max-w-full truncate justify-self-end rounded text-right text-muted-foreground text-xs transition-colors hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none md:inline-block"
          onClick={filterByOwner}
          type="button"
        >
          {ownerName}
        </button>
      ) : (
        <span className="pointer-events-none relative z-[2] hidden max-w-full truncate justify-self-end text-muted-foreground text-xs md:inline">
          Anonymous
        </span>
      )}

      <span className="pointer-events-none relative z-[2] justify-self-end font-semibold text-foreground text-sm tabular-nums">
        {callCountLabel(row.callCount)}
      </span>

      <span className="pointer-events-none relative z-[2] justify-self-end font-mono font-semibold text-foreground text-xs tabular-nums">
        {price}
      </span>

      {badge ? (
        <span className="pointer-events-none relative z-[2] hidden items-center justify-center justify-self-end rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-semibold text-[0.625rem] text-[var(--color-text-accent)] md:inline-flex">
          {badge.label}
        </span>
      ) : (
        <span aria-hidden="true" className="hidden md:inline" />
      )}
    </article>
  );
}
