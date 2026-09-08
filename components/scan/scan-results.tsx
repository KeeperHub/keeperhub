"use client";

import { AlertCircle, Clock } from "lucide-react";
import { useMemo } from "react";
import { ResultsHeader } from "@/components/scan/results-header";
import { SuggestionCard } from "@/components/scan/suggestion-card";
import { SuggestionCardSkeleton } from "@/components/scan/suggestion-card-skeleton";
import { buildBaselineSuggestions } from "@/lib/scan/suggestions/baseline";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { ScanResponse } from "@/lib/scan/types";

type ScanState = "loading" | "populated" | "empty" | "rate-limited" | "error";

type ScanResultsProps = {
  scanState: ScanState;
  data: ScanResponse | null;
  retryAfter: number | null;
  errorMessage: string | null;
  onCardSelect: (
    suggestion: SuggestionDescriptor,
    variants: SuggestionDescriptor[]
  ) => void;
};

/**
 * A results-grid entry: one card backed by one or more sibling descriptors.
 * Multi-variant groups collapse per-(token, network) suggestions into a
 * single card; the token/network choice happens inside the preview drawer.
 */
export type SuggestionGroup = {
  display: SuggestionDescriptor;
  variants: SuggestionDescriptor[];
};

/** Non-alphanumeric runs, for slugifying venue labels into group ids. */
const NON_ALNUM_RE = /[^a-z0-9]+/g;

function membersSummary(members: SuggestionDescriptor[]): {
  symbols: string[];
  networksLabel: string;
  total: number;
} {
  const symbols = [
    ...new Set(members.map((m) => m.symbol ?? "").filter(Boolean)),
  ];
  const networkCount = new Set(members.map((m) => m.chainId)).size;
  return {
    symbols,
    networksLabel: `${networkCount} network${networkCount === 1 ? "" : "s"}`,
    total: members.reduce((sum, m) => sum + (m.usdValue ?? 0), 0),
  };
}

function yieldGroupDescription(
  members: SuggestionDescriptor[],
  venue: string
): string {
  const { symbols, networksLabel, total } = membersSummary(members);
  const bestApy = members.reduce<number | undefined>(
    (best, m) =>
      m.apy !== undefined && (best === undefined || m.apy > best)
        ? m.apy
        : best,
    undefined
  );
  const apyPart =
    bestApy === undefined
      ? ""
      : ` Earn up to ~${bestApy.toFixed(1)}% APY${venue ? ` via ${venue}` : ""}.`;
  return (
    `Idle stablecoins detected: ${symbols.join(", ")} ` +
    `($${Math.round(total)} across ${networksLabel}).${apyPart} ` +
    "Pick a token and network in the preview."
  );
}

function balanceDropGroupDescription(members: SuggestionDescriptor[]): string {
  const { symbols, networksLabel } = membersSummary(members);
  return (
    "Tripwire for unexpected outflows: alerts when a balance drops below " +
    `its scanned level. Covers ${symbols.join(", ")} across ${networksLabel}. ` +
    "Pick a token and network in the preview."
  );
}

function depegGroupDescription(members: SuggestionDescriptor[]): string {
  const { symbols } = membersSummary(members);
  return (
    "Alerts if a held stablecoin loses its $1 peg (Chainlink price below " +
    `$0.995). Covers ${symbols.join(", ")}. Pick a token in the preview.`
  );
}

function gasGroupDescription(members: SuggestionDescriptor[]): string {
  const { networksLabel } = membersSummary(members);
  return (
    "Alerts when your native token balance runs low (below 0.01) on any of " +
    `your ${networksLabel}. Pick a network in the preview.`
  );
}

/** Alert families that collapse into one card per family. */
const SIMPLE_FAMILIES = [
  {
    prefix: "balance-drop-",
    id: "group-balance-drop",
    name: "Stablecoin Drop Alert",
    describe: balanceDropGroupDescription,
  },
  {
    prefix: "depeg-watch-",
    id: "group-depeg-watch",
    name: "Stablecoin Depeg Watch",
    describe: depegGroupDescription,
  },
  {
    prefix: "gas-balance-",
    id: "group-gas-balance",
    name: "Native Token Balance Alert",
    describe: gasGroupDescription,
  },
] as const;

/**
 * Group yield suggestions by venue: one card per protocol (e.g. Morpho Blue,
 * Aave V3), each collapsing its (token, network) variants. Venue-less
 * (generic-degrade) suggestions form their own group.
 */
function buildYieldGroups(members: SuggestionDescriptor[]): SuggestionGroup[] {
  const byVenue = new Map<string, SuggestionDescriptor[]>();
  for (const m of members) {
    const key = m.venue ?? "";
    const bucket = byVenue.get(key) ?? [];
    bucket.push(m);
    byVenue.set(key, bucket);
  }

  const groups: SuggestionGroup[] = [];
  for (const [venue, bucket] of byVenue) {
    if (bucket.length === 1) {
      groups.push({ display: bucket[0], variants: bucket });
      continue;
    }
    const venueSlug = venue
      ? venue.toLowerCase().replace(NON_ALNUM_RE, "-")
      : "generic";
    groups.push({
      display: {
        ...bucket[0],
        id: `group-stablecoin-yield-${venueSlug}`,
        name: venue
          ? `Stablecoin Yield Opportunity · ${venue}`
          : "Stablecoin Yield Opportunity",
        description: yieldGroupDescription(bucket, venue),
      },
      variants: bucket,
    });
  }
  return groups;
}

/**
 * Collapse per-(token, network) sibling suggestions into cards, preserving
 * the engine's ranking order (a group sorts at its best member's original
 * position). Yield suggestions group per venue; balance-drop tripwires
 * collapse into one card; everything else stays individual.
 */
function buildGroups(suggestions: SuggestionDescriptor[]): SuggestionGroup[] {
  const grouped = new Set<string>();
  const groups: SuggestionGroup[] = [];

  const yieldMembers = suggestions.filter((s) =>
    s.id.startsWith("stablecoin-yield-")
  );
  for (const m of yieldMembers) {
    grouped.add(m.id);
  }
  groups.push(...buildYieldGroups(yieldMembers));

  for (const family of SIMPLE_FAMILIES) {
    const members = suggestions.filter((s) => s.id.startsWith(family.prefix));
    for (const m of members) {
      grouped.add(m.id);
    }
    if (members.length === 1) {
      groups.push({ display: members[0], variants: members });
    } else if (members.length > 1) {
      groups.push({
        display: {
          ...members[0],
          id: family.id,
          name: family.name,
          description: family.describe(members),
        },
        variants: members,
      });
    }
  }

  for (const s of suggestions) {
    if (!grouped.has(s.id)) {
      groups.push({ display: s, variants: [s] });
    }
  }

  const rankOf = (g: SuggestionGroup): number =>
    suggestions.findIndex((s) => s.id === g.variants[0].id);
  return groups.sort((a, b) => rankOf(a) - rankOf(b));
}

export function ScanResults({
  scanState,
  data,
  retryAfter,
  errorMessage,
  onCardSelect,
}: ScanResultsProps): React.ReactElement {
  const groups = useMemo(
    () => buildGroups(data?.suggestions ?? []),
    [data?.suggestions]
  );

  return (
    <section
      aria-busy={scanState === "loading"}
      aria-label="Scan results"
      aria-live="polite"
      className="mt-8"
    >
      {scanState === "loading" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SuggestionCardSkeleton />
          <SuggestionCardSkeleton />
          <SuggestionCardSkeleton />
        </div>
      )}

      {scanState === "populated" && data && (
        <>
          <ResultsHeader
            addressKind={data.addressKind}
            contractChains={data.contractChains}
            positions={data.positions}
            stablecoins={data.stablecoins}
            unavailableChains={data.unavailableChains}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => (
              <SuggestionCard
                key={group.display.id}
                networkCount={
                  new Set(group.variants.map((v) => v.chainId)).size
                }
                onSelect={() => onCardSelect(group.variants[0], group.variants)}
                suggestion={group.display}
              />
            ))}
          </div>
        </>
      )}

      {scanState === "empty" && (
        <div data-testid="scan-results-empty">
          {data?.addressKind !== undefined && (
            <ResultsHeader
              addressKind={data.addressKind}
              contractChains={data.contractChains}
              positions={data.positions}
              stablecoins={data.stablecoins}
              unavailableChains={data.unavailableChains}
            />
          )}
          <div className="mb-5">
            <h3 className="font-semibold text-foreground text-sm">
              No DeFi positions detected
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              We scanned every supported network and found no lending, staking,
              or stablecoin positions. These monitors work for any address — set
              one up to get started.
            </p>
          </div>
          {data?.address ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {buildBaselineSuggestions(data.address).map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  onSelect={() => onCardSelect(suggestion, [suggestion])}
                  suggestion={suggestion}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {scanState === "rate-limited" && (
        <div
          className="flex items-start gap-3 rounded-md border border-[var(--color-border-error)] bg-[var(--color-bg-error)] px-4 py-3"
          data-testid="scan-results-rate-limited"
          role="alert"
        >
          <Clock
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-error)]"
          />
          <p className="text-[var(--color-text-error)] text-sm">
            Too many scan requests. Try again in {retryAfter} minute
            {retryAfter === 1 ? "" : "s"}.
          </p>
        </div>
      )}

      {scanState === "error" && (
        <div
          className="flex items-start gap-3 rounded-md border border-[var(--color-border-error)] bg-[var(--color-bg-error)] px-4 py-3"
          data-testid="scan-results-error"
          role="alert"
        >
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-error)]"
          />
          <p className="text-[var(--color-text-error)] text-sm">
            {errorMessage ??
              "Unable to scan this address. Check that it is a valid EVM address and try again."}
          </p>
        </div>
      )}
    </section>
  );
}
