"use client";

import {
  Bell,
  Box,
  ChevronRight,
  Coins,
  Gift,
  ShieldCheck,
} from "lucide-react";
import Image from "next/image";
import type { KeyboardEvent } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getChainName } from "@/lib/chain-utils";
import type {
  SuggestionCategory,
  SuggestionDescriptor,
} from "@/lib/scan/suggestions/types";
import { CategoryBadge } from "./category-badge";
import { ReadWritePill } from "./read-write-pill";

type SuggestionCardProps = {
  suggestion: SuggestionDescriptor;
  onSelect: (suggestion: SuggestionDescriptor) => void;
  /**
   * Number of networks covered when this card fronts a grouped set of
   * sibling suggestions. Above 1, the chain pill shows "N networks" instead
   * of a single chain name.
   */
  networkCount?: number;
};

/** Protocol/venue logos served from public/protocols. */
const PROTOCOL_ICONS: Record<string, string> = {
  aave: "/protocols/aave.png",
  morpho: "/protocols/morpho.png",
  sky: "/protocols/sky.png",
  spark: "/protocols/spark.png",
  lido: "/protocols/lido.png",
  compound: "/protocols/compound.png",
};

/** Lucide fallback icon per category when no protocol logo maps. */
const CATEGORY_FALLBACK_ICON: Record<SuggestionCategory, typeof Box> = {
  yield: Coins,
  health: ShieldCheck,
  alert: Bell,
  claim: Gift,
};

/**
 * Resolve a protocol/venue logo for the card icon tile.
 *
 * Health/alert/claim suggestions carry a `protocol` slug; yield suggestions
 * name the venue in `name` (format controlled by projectSlugToLabel), so a
 * keyword match is stable. Returns null when nothing maps (category fallback).
 */
function resolveProtocolIcon(suggestion: SuggestionDescriptor): string | null {
  const proto = suggestion.protocol ?? "";
  if (proto.startsWith("aave")) {
    return PROTOCOL_ICONS.aave;
  }
  if (proto.startsWith("spark")) {
    return PROTOCOL_ICONS.spark;
  }
  if (proto === "lido") {
    return PROTOCOL_ICONS.lido;
  }
  if (proto === "sky") {
    return PROTOCOL_ICONS.sky;
  }
  const label = suggestion.name.toLowerCase();
  if (label.includes("aave")) {
    return PROTOCOL_ICONS.aave;
  }
  if (label.includes("morpho")) {
    return PROTOCOL_ICONS.morpho;
  }
  if (label.includes("sky")) {
    return PROTOCOL_ICONS.sky;
  }
  if (label.includes("spark")) {
    return PROTOCOL_ICONS.spark;
  }
  if (label.includes("lido")) {
    return PROTOCOL_ICONS.lido;
  }
  if (label.includes("compound")) {
    return PROTOCOL_ICONS.compound;
  }
  return null;
}

export function SuggestionCard({
  suggestion,
  onSelect,
  networkCount,
}: SuggestionCardProps): React.ReactElement {
  const handleClick = (): void => {
    onSelect(suggestion);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(suggestion);
    }
  };

  const iconSrc = resolveProtocolIcon(suggestion);
  const FallbackIcon = CATEGORY_FALLBACK_ICON[suggestion.category] ?? Box;

  return (
    // biome-ignore lint/a11y/useSemanticElements: card uses an <article> with role="link" + ::before overlay per UI-SPEC §1; wrapping <a> is forbidden to preserve nested-button a11y
    <article
      aria-label={`Open ${suggestion.name} preview`}
      className="group relative flex min-h-[160px] cursor-pointer flex-col rounded-xl border border-border/20 bg-[var(--color-hub-card)] p-4 shadow-sm transition-all duration-150 before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:rounded-xl before:content-[''] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--color-border-accent)_45%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-overlay)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: card uses article role="link" per UI-SPEC §1; click is delivered via the ::before overlay and onKeyDown handler
      role="link"
      tabIndex={0}
    >
      <div className="pointer-events-none relative z-[2] flex items-start justify-between gap-3">
        <div className="flex size-12 items-center justify-center rounded-lg bg-[var(--color-hub-icon-bg)]">
          {iconSrc ? (
            <Image
              alt=""
              className="size-8 object-contain"
              height={32}
              src={iconSrc}
              width={32}
            />
          ) : (
            <FallbackIcon
              aria-hidden="true"
              className="size-6 text-[var(--color-text-accent)]"
            />
          )}
        </div>
        <CategoryBadge category={suggestion.category} />
      </div>
      <h3 className="pointer-events-none relative z-[2] mt-3 line-clamp-2 font-semibold text-foreground text-sm">
        {suggestion.name}
      </h3>
      <p className="pointer-events-none relative z-[2] mt-1 line-clamp-3 text-muted-foreground/80 text-xs leading-normal">
        {suggestion.description}
      </p>
      <div className="pointer-events-none relative z-[2] mt-auto flex items-center gap-2 pt-3">
        <span className="inline-flex items-center rounded-full border border-border/40 bg-muted/60 px-2 py-0.5 font-medium text-[0.625rem] text-foreground/80">
          {networkCount !== undefined && networkCount > 1
            ? `${networkCount} networks`
            : getChainName(String(suggestion.chainId))}
        </span>
        <Tooltip>
          <TooltipTrigger className="pointer-events-auto inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)]">
            <ReadWritePill value={suggestion.readOrWrite} />
          </TooltipTrigger>
          <TooltipContent className="max-w-[220px]">
            {suggestion.riskNote}
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto inline-flex items-center gap-0.5 font-medium text-[0.6875rem] text-muted-foreground/70 transition-colors group-hover:text-[var(--color-text-accent)]">
          Preview
          <ChevronRight
            aria-hidden="true"
            className="size-3 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
          />
        </span>
      </div>
    </article>
  );
}
