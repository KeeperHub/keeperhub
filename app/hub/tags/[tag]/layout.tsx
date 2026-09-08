import type { ReactNode } from "react";

/**
 * Tag-route layout (HUB-08).
 *
 * Pass-through layout that lets the page-level `generateMetadata` own
 * every per-tag SEO field (title, description, canonical, robots).
 * The base Hub OG/Twitter cards are inherited from `app/hub/layout.tsx`
 * unless the page overrides them.
 */
export default function TagLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return children;
}
