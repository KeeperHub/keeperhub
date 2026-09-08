import { count, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import HubViewShell from "@/app/hub/_view-shell";
import { db } from "@/lib/db";
import { publicTags, workflowPublicTags } from "@/lib/db/schema";
import { isReservedSlug } from "@/lib/workflow/reserved-slugs";

// Force per-request rendering. The page already reads `cookies()` so SSG was
// nominal anyway, but classifying it as SSG (via `generateStaticParams`) +
// `dynamicParams` + on-demand fallback caused `notFound()` to surface as 500
// in Next 16 production. Forcing `dynamic` drops the SSG bucket and the 500
// with it.
export const dynamic = "force-dynamic";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

type Params = { tag: string };

type TagRecord = typeof publicTags.$inferSelect;

type LoadedTag = {
  tag: TagRecord;
  workflowsCount: number;
};

type ViewMode = "cards" | "list";

function readView(value: string | undefined): ViewMode {
  return value === "list" ? "list" : "cards";
}

async function loadTag(slug: string): Promise<LoadedTag | null> {
  if (isReservedSlug(slug)) {
    return null;
  }

  const tagRows = await db
    .select()
    .from(publicTags)
    .where(eq(publicTags.slug, slug))
    .limit(1);

  const tag = tagRows[0];
  if (!tag) {
    return null;
  }

  const countRows = await db
    .select({ value: count() })
    .from(workflowPublicTags)
    .where(eq(workflowPublicTags.publicTagId, tag.id));

  const workflowsCount = Number(countRows[0]?.value ?? 0);
  return { tag, workflowsCount };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { tag: slug } = await params;
  const loaded = await loadTag(slug);

  if (!loaded) {
    return {
      title: "Tag not found · KeeperHub Hub",
    };
  }

  const { tag, workflowsCount } = loaded;
  const title = `${tag.name} templates · KeeperHub Hub`;
  const description = `Browse community-built workflow templates tagged "${tag.name}". Copy and customize for your own automations.`;
  const canonicalPath = `/hub/tags/${tag.slug}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      url: `${baseUrl}${canonicalPath}`,
      siteName: "KeeperHub",
      type: "website",
      images: [
        {
          // Per-tag OG generation deferred to HUB-FUTURE-02; reuse default Hub OG.
          url: `${baseUrl}/api/og/hub`,
          width: 1200,
          height: 630,
          alt: `KeeperHub Workflow Hub · ${tag.name}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: `Browse community-built workflow templates tagged "${tag.name}".`,
      images: [`${baseUrl}/api/og/hub`],
    },
    // HUB-14: empty tag pages noindex,follow rather than 404
    robots: workflowsCount === 0 ? { index: false, follow: true } : undefined,
  };
}

export default async function TagPage({
  params,
}: {
  params: Promise<Params>;
}): Promise<React.ReactElement> {
  const { tag: slug } = await params;
  const loaded = await loadTag(slug);

  if (!loaded) {
    notFound();
  }

  // Reuse the same client shell as `/hub` so layout, view toggle, and
  // results grid stay identical. Pass the tag slug as initialTagSlug so the
  // shared shell applies the same single-tag filter the sidebar drives via
  // ?tag= on /hub. The canonical /hub/tags/{slug} route remains the SEO
  // surface (sitemap + canonical link) — only the sidebar links shifted to
  // the query-param form for smooth client-side filtering.
  const cookieStore = await cookies();
  const initialView = readView(cookieStore.get("hub_view")?.value);
  return (
    <HubViewShell initialTagSlug={loaded.tag.slug} initialView={initialView} />
  );
}
