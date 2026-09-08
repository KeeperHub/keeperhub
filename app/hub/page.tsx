// Pure (non-"use client") module so this Server Component can call the type
// guard safely; importing through _tabs-shell would trip Next.js' RSC
// "Attempted to call isHubTabValue() from the server" error.
import type { Metadata } from "next";
import { HubExternalLinks } from "@/components/hub/hub-external-links";
import { HubHero } from "@/components/hub/hub-hero";
import { HubTabSearch } from "@/components/hub/hub-tab-search";
import { HubMarketplaceTab } from "./_marketplace-tab";
import { HubProtocolsTab } from "./_protocols-tab";
import { type HubTabValue, isHubTabValue } from "./_tabs-shared";
import { HubTabsShell } from "./_tabs-shell";
import { HubWorkflowsTab } from "./_workflows-tab";

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

// /hub reads ?tab= / ?tag= / ?q= / ?sort= / ?cursor= from searchParams,
// so every request renders a different surface. force-dynamic prevents
// the segment-level output cache from serving the same HTML across
// distinct query combos (which silently broke per-query filtering).
// Data-layer caching for the Marketplace tab still happens via the
// unstable_cache(60s) wrapper around fetchMarketplaceLeaderboard.
export const dynamic = "force-dynamic";

type HubPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type MetadataProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type TabMetadata = {
  title: string;
  description: string;
};

const DEFAULT_TAB: HubTabValue = "protocols";

// MARKET-12: per-tab title + description. OG image stays on the existing
// /api/og/hub default route for all tabs (per HUB-FUTURE-02 — per-tab OG
// generation is deferred). Default branch (no `?tab=`) uses the umbrella
// "Hub" title rather than the per-tab string so direct shares to /hub keep
// surfacing all three tabs in the description.
const TAB_METADATA: Record<HubTabValue | "default", TabMetadata> = {
  default: {
    title: "Hub · KeeperHub",
    description:
      "Browse protocols, fork community workflows, and discover paid services on the marketplace.",
  },
  protocols: {
    title: "Protocols · Hub | KeeperHub",
    description:
      "Browse Web3 protocols KeeperHub workflows can interact with: Aave, Uniswap, Compound, and more.",
  },
  workflows: {
    title: "Workflows · Hub | KeeperHub",
    description:
      "Browse community workflow templates. Fork any template to your organisation in one click.",
  },
  marketplace: {
    title: "Marketplace · Hub | KeeperHub",
    description:
      "Discover paid services. Listed workflows ranked by call count, callable by humans and AI agents.",
  },
} as const;

function readInitialTab(value: string | string[] | undefined): HubTabValue {
  if (typeof value !== "string") {
    return DEFAULT_TAB;
  }
  const normalized = value.trim().toLowerCase();
  return isHubTabValue(normalized) ? normalized : DEFAULT_TAB;
}

function readTagSlug(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Cap query length to prevent unstable_cache key pollution via random
// `?q=` spam — each distinct cache key triggers a fresh DB hit before
// the data cache.
const MAX_QUERY_LENGTH = 100;

function readQuery(value: string | string[] | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_QUERY_LENGTH);
}

function metaForTab(value: string | string[] | undefined): TabMetadata {
  if (typeof value !== "string") {
    return TAB_METADATA.default;
  }
  const normalized = value.trim().toLowerCase();
  return isHubTabValue(normalized)
    ? TAB_METADATA[normalized]
    : TAB_METADATA.default;
}

export async function generateMetadata({
  searchParams,
}: MetadataProps): Promise<Metadata> {
  const params = await searchParams;
  const meta = metaForTab(params.tab);
  const ogImageUrl = `${APP_BASE_URL}/api/og/hub`;
  return {
    title: meta.title,
    description: meta.description,
    // Explicit, because the root layout declares `alternates: { canonical: "/" }`
    // and Next.js merges metadata root-to-leaf per top-level key: a route that
    // does not declare `alternates` inherits the root's. Without this, /hub -
    // the public catalog, and the highest-priority non-root sitemap entry -
    // would tell crawlers it is a duplicate of the homepage and be consolidated
    // away, taking every protocol page under it.
    //
    // The tab is deliberately not part of the canonical: ?tab= renders a
    // different slice of one catalog, and robots.ts already disallows the
    // query-string variants (HUB-13).
    alternates: { canonical: "/hub" },
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: "website",
      url: `${APP_BASE_URL}/hub`,
      siteName: "KeeperHub",
      // HUB-FUTURE-02: per-tab OG generation deferred. Default Hub OG used
      // for every tab — keeps the share-card story coherent until the
      // per-tab OG renderer ships.
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: "KeeperHub Hub",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [ogImageUrl],
    },
  };
}

export default async function HubPage({
  searchParams,
}: HubPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const initialTab = readInitialTab(params.tab);
  const initialTagSlug = readTagSlug(params.tag);
  const query = readQuery(params.q);

  // Tab content is passed to HubTabsShell as RSC slot props.
  const protocolsContent = <HubProtocolsTab query={query} />;
  const workflowsContent = <HubWorkflowsTab initialTagSlug={initialTagSlug} />;
  const marketplaceContent = (
    <HubMarketplaceTab query={query} searchParams={params} />
  );

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-x-hidden overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-h-full flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="container mx-auto max-w-7xl px-6 pb-8 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <HubHero />
          <HubTabsShell
            actionsSlot={<HubExternalLinks />}
            initialTab={initialTab}
            marketplaceContent={marketplaceContent}
            protocolsContent={protocolsContent}
            searchSlot={<HubTabSearch />}
            workflowsContent={workflowsContent}
          />
        </div>
      </div>
    </div>
  );
}
