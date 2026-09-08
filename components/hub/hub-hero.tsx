"use client";

import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";

const HERO_SUB =
  "Browse DeFi protocols, fork community workflows, and discover paid services on the marketplace.";

type HubHeroProps = {
  /**
   * @deprecated Phase 44 moved the search input into the tab-strip band
   * (`components/hub/hub-tab-search.tsx`, wired in plan 44-09). This prop
   * is preserved only for backwards-compatible imports during the migration
   * window. The hero no longer renders a search input.
   */
  searchQuery?: string;
  /** @deprecated See searchQuery — unused in Phase 44. */
  onSearchChange?: (query: string) => void;
};

function trimmedName(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function HubHero(_props: HubHeroProps = {}): React.ReactElement {
  const { data: session, isPending } = useSession();
  // Show the bare headline on first paint and for anonymous / signed-out
  // users. Signed-in users get their full name appended.
  const showName =
    !isPending && session?.user && !isAnonymousUser(session.user);
  const name = showName ? trimmedName(session?.user?.name) : null;
  const headline = name
    ? `Welcome to KeeperHub ${name}!`
    : "Welcome to KeeperHub!";

  return (
    <div className="pb-6">
      <h1 className="font-semibold text-xl tracking-tight">{headline}</h1>
      <p className="mt-1 text-muted-foreground text-sm">{HERO_SUB}</p>
    </div>
  );
}
