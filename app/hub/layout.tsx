import type { ReactNode } from "react";

// Phase 44 plan 44-09: per-tab metadata moved to `app/hub/page.tsx` via
// `generateMetadata({ searchParams })` (MARKET-12). This layout no longer
// declares static metadata so the page-level generator owns title,
// description, openGraph and twitter unambiguously — Next.js metadata merge
// rules replace at the leaf-key level, and keeping a static `title` here
// would only race with the dynamic per-tab title.

type HubLayoutProps = { children: ReactNode };

export default function HubLayout({
  children,
}: HubLayoutProps): React.ReactElement {
  return <>{children}</>;
}
