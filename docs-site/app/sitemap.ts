import type { MetadataRoute } from "next";
import { generateStaticParamsFor } from "nextra/pages";

/**
 * sitemap.xml for the documentation site.
 *
 * There was no sitemap here either - docs.keeperhub.com/sitemap.xml returned
 * 404 - so a crawler had nothing to enumerate the docs from except llms.txt,
 * which is hand-maintained and lists a curated subset rather than every page.
 *
 * Routes come from Nextra's own static-params generator, the same call
 * app/[[...mdxPath]]/page.tsx uses to decide what exists. Deriving them from
 * the framework rather than re-walking content/ means the sitemap cannot list a
 * page that does not render, or miss one that does.
 */

const BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.keeperhub.com";

type MdxParams = { mdxPath?: string[] };

/** The docs landing page, which agents and crawlers should reach first. */
const ROOT_PRIORITY = 1.0;
/** A top-level section index (/api, /cli, /agent, ...). */
const SECTION_PRIORITY = 0.8;
/** An individual page inside a section. */
const PAGE_PRIORITY = 0.6;

function priorityFor(segments: string[]): number {
  if (segments.length === 0) {
    return ROOT_PRIORITY;
  }
  return segments.length === 1 ? SECTION_PRIORITY : PAGE_PRIORITY;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const params = (await generateStaticParamsFor("mdxPath")()) as MdxParams[];

  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  for (const { mdxPath } of params) {
    // Nextra represents the site root as [""], not [], so empty segments have
    // to be dropped before the length is used to weight the entry - otherwise
    // the landing page scores as a section rather than the root.
    const segments = (mdxPath ?? []).filter((segment) => segment.length > 0);
    const url = `${BASE_URL}/${segments.join("/")}`.replace(/\/$/, "") || BASE_URL;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    entries.push({
      url,
      changeFrequency: "weekly",
      priority: priorityFor(segments),
    });
  }

  return entries;
}
