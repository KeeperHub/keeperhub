import type { MetadataRoute } from "next";
import "@/protocols";
import { db } from "@/lib/db";
import { publicTags } from "@/lib/db/schema";
import { logWarn } from "@/lib/logging";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { PUBLIC_PAGE_PATHS, publicPages } from "@/lib/site/content";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

// The build container has no DB, so the build-time render never has tags.
// Regenerating at runtime is what gets them into the served sitemap.
export const revalidate = 3600;

/**
 * Sitemap metadata route (HUB-12, HUB-13).
 *
 * Enumerates the public surface area:
 *   - every page in lib/site/content.ts
 *   - the Hub index (/hub)
 *   - one entry per registered protocol as /hub/protocol/{slug}
 *   - one entry per row in `publicTags` as /hub/tags/{slug}
 *
 * Rendered at build time and regenerated hourly at runtime; the
 * publicTags table is small (<100 expected rows) so an unbounded select
 * is safe today. If it grows beyond ~10k rows, switch to the paginated
 * sitemap-index pattern.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Build container has no DB access — see same pattern in
  // app/hub/tags/[tag]/page.tsx generateStaticParams. Fall back to a
  // sitemap with only the static surface so the build doesn't fail.
  // Real prod builds with DATABASE_URL set rethrow so misconfigurations
  // surface loud rather than silently shipping an empty sitemap.
  let tagRows: { slug: string; createdAt: Date }[] = [];
  try {
    tagRows = await db
      .select({ slug: publicTags.slug, createdAt: publicTags.createdAt })
      .from(publicTags);
  } catch (err) {
    const isConfiguredProdBuild =
      process.env.NODE_ENV === "production" &&
      Boolean(process.env.DATABASE_URL);
    if (isConfiguredProdBuild) {
      throw err;
    }
    logWarn("[sitemap] tag DB read failed, emitting static-only sitemap", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const tagEntries: MetadataRoute.Sitemap = tagRows.map((row) => ({
    url: `${baseUrl}/hub/tags/${row.slug}`,
    lastModified: row.createdAt,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  // The public pages, driven off lib/site/content.ts so a page added there is
  // crawlable without a second edit here. `/hub` is not a SitePage (it renders
  // live catalog data) so it stays listed explicitly.
  const pages = publicPages();
  const publicEntries: MetadataRoute.Sitemap = PUBLIC_PAGE_PATHS.map(
    (path) => ({
      url: `${baseUrl}${path === "/" ? "/" : path}`,
      changeFrequency:
        path === "/" ? ("weekly" as const) : ("monthly" as const),
      priority: pages[path]?.priority ?? 0.5,
    })
  );

  const protocolEntries: MetadataRoute.Sitemap = getRegisteredProtocols().map(
    (protocol) => ({
      url: `${baseUrl}/hub/protocol/${protocol.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })
  );

  const staticEntries: MetadataRoute.Sitemap = [
    ...publicEntries,
    {
      url: `${baseUrl}/hub`,
      changeFrequency: "daily",
      priority: 0.9,
    },
  ];

  return [...staticEntries, ...protocolEntries, ...tagEntries];
}
