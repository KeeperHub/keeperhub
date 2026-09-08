import type { MetadataRoute } from "next";
import { AGENT_CRAWLER_USER_AGENTS } from "../lib/crawlers";

/**
 * robots.txt for the documentation site.
 *
 * There was no robots.txt here at all - docs.keeperhub.com/robots.txt returned
 * 404 - so crawler policy for the host agents most want to read was "allowed by
 * omission". That is not something an operator reviewing an edge rule, or an
 * agent deciding whether to fetch, can act on.
 *
 * The agent list must stay identical to the one the edge exempts on this host
 * (rules 1 and 5 in prod/keeperhub-infrastructure/cloudflare.tf in the
 * techops-services/infrastructure repo) and to lib/site/crawlers.ts in the
 * parent repo. A UA invited here and refused at the edge is worse than either
 * policy alone: the crawler retries against a 403 and a readiness audit reads
 * the 403 as "unreachable". tests/unit/docs-markdown.test.ts pins the three
 * lists together.
 */

const BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.keeperhub.com";


/**
 * `_md` is allowed on purpose. It holds the Markdown representation of every
 * page - the thing an agent most wants - and hiding it would mean advertising
 * content negotiation while forbidding the crawl of what it returns.
 */
const ALLOW: readonly string[] = ["/"];

const DISALLOW: readonly string[] = ["/_next/", "/_pagefind/"];

export default function robots(): MetadataRoute.Robots {
  const rule = { allow: [...ALLOW], disallow: [...DISALLOW] };
  return {
    rules: [
      { userAgent: "*", ...rule },
      ...AGENT_CRAWLER_USER_AGENTS.map((userAgent) => ({ userAgent, ...rule })),
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    // Bare hostname, not a URL - see the same note in app/robots.ts.
    host: new URL(BASE_URL).host,
  };
}
