import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

/**
 * robots.txt metadata route (HUB-13).
 *
 * Disallows query-string variants of /hub and /marketplace so crawlers
 * don't index every filter permutation. Canonical paths remain crawlable
 * via the explicit allow list, and tag deep-links live at /hub/tags/[tag].
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/hub", "/hub/tags/", "/marketplace"],
        disallow: [
          "/api/",
          "/auth/",
          "/workflows/",
          // disallow query-string variants — canonical is /hub/tags/[tag] (HUB-13)
          "/hub?",
          // disallow query-string variants on /marketplace (HUB-13)
          "/marketplace?",
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
