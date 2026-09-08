import type { MetadataRoute } from "next";
import { AGENT_CRAWLER_USER_AGENTS } from "@/lib/site/crawlers";
import { appUrl } from "@/lib/site/identity";

/**
 * robots.txt metadata route (HUB-13).
 *
 * Two jobs. First, keep crawlers off the query-string variants of /hub and
 * /marketplace so we do not get every filter permutation indexed; canonical
 * paths stay crawlable and tag deep-links live at /hub/tags/[tag].
 *
 * Second, state explicitly that AI agent crawlers are welcome. The default `*`
 * rule already allows them, but "allowed by omission" is not something an
 * operator reviewing a WAF rule, or an agent deciding whether to fetch, can act
 * on. Naming the agents makes the intent legible on both sides - and this file
 * is the half of that intent we control in code. The edge (Cloudflare bot
 * management) enforces its own policy and has to agree; robots.txt does not
 * override it.
 */

/** Public surfaces every crawler may read, agent or otherwise. */
const PUBLIC_ALLOW: readonly string[] = [
  "/",
  "/hub",
  "/hub/tags/",
  "/marketplace",
  "/welcome",
];

/**
 * Machine-readable documents. Listed ahead of the `/api/` disallow because
 * robots.txt precedence is longest-match, not first-match: `/api/openapi` is
 * more specific than `/api/`, so it stays reachable.
 */
const MACHINE_READABLE_ALLOW: readonly string[] = [
  "/.well-known/",
  "/api/openapi",
  "/openapi.json",
  "/sitemap.xml",
];

const DISALLOW: readonly string[] = [
  "/api/",
  "/auth/",
  "/workflows/",
  // disallow query-string variants — canonical is /hub/tags/[tag] (HUB-13)
  "/hub?",
  // disallow query-string variants on /marketplace (HUB-13)
  "/marketplace?",
];

export default function robots(): MetadataRoute.Robots {
  const baseUrl = appUrl();
  const allow = [...PUBLIC_ALLOW, ...MACHINE_READABLE_ALLOW];
  return {
    rules: [
      {
        userAgent: "*",
        allow,
        disallow: [...DISALLOW],
      },
      // Named explicitly so that narrowing the wildcard rule later cannot
      // silently take the agent crawlers out with it.
      ...AGENT_CRAWLER_USER_AGENTS.map((userAgent) => ({
        userAgent,
        allow,
        disallow: [...DISALLOW],
      })),
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    // Bare hostname. The Host directive is not a URL, and a crawler discards
    // the line if it carries a scheme.
    host: new URL(baseUrl).host,
  };
}
