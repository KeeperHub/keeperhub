import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The root layout declares `alternates: { canonical: "/" }`, and Next.js merges
 * metadata root-to-leaf per top-level key: a route that does not declare
 * `alternates` inherits the root's. So every crawlable route must set its own,
 * or it reports itself a duplicate of the homepage and gets consolidated away.
 *
 * This bit /hub in review - the public catalog, the highest-priority non-root
 * sitemap entry, and explicitly allowed in robots.ts. Nothing caught it: the
 * repo's only canonical assertion is an e2e test on /hub/tags/[tag], which is
 * the one hub route that already set its own.
 *
 * Source-level assertions rather than calling generateMetadata, because these
 * page modules pull in the DB, the protocol registry and React components. The
 * point is to make an omission fail loudly, and a missing `alternates` key in
 * the file is exactly the omission.
 */

/** Page files backing the paths robots.ts allows. */
const CRAWLABLE_ROUTE_FILES: readonly { route: string; file: string }[] = [
  { route: "/hub", file: "app/hub/page.tsx" },
  { route: "/hub/protocol/[slug]", file: "app/hub/protocol/[slug]/page.tsx" },
  { route: "/hub/tags/[tag]", file: "app/hub/tags/[tag]/page.tsx" },
];

function source(file: string): string {
  return readFileSync(file, "utf8");
}

describe("canonical URLs on crawlable routes", () => {
  it("declares a canonical on the root layout", () => {
    // If this is ever removed, the routes below stop inheriting a wrong value
    // and this whole suite becomes unnecessary - but that should be deliberate,
    // not silent, because /welcome relies on inheriting it.
    expect(source("app/layout.tsx")).toContain(
      'alternates: { canonical: "/" }'
    );
  });

  it.each(CRAWLABLE_ROUTE_FILES)("$route declares its own alternates", ({
    file,
  }) => {
    expect(source(file)).toContain("alternates");
  });

  it("points /hub at itself, not the homepage", () => {
    expect(source("app/hub/page.tsx")).toContain(
      'alternates: { canonical: "/hub" }'
    );
  });

  it("points each protocol page at its own slug", () => {
    // Asserted as a prefix so the interpolation is not written as a literal
    // "${...}" in a plain string, which Biome flags as a likely mistake.
    expect(source("app/hub/protocol/[slug]/page.tsx")).toContain(
      "alternates: { canonical: `/hub/protocol/"
    );
  });

  it("does not reintroduce app-side copies of the marketing pages", async () => {
    // /about, /contact, /privacy and /pricing live on keeperhub.com. A second
    // self-canonical copy here competes with them for the same query, which is
    // why they were removed. Adding one back should be a deliberate act.
    const { PUBLIC_PAGE_PATHS } = await import("@/lib/site/content");
    for (const path of [
      "/about",
      "/contact",
      "/privacy",
      "/pricing",
      "/developers",
    ]) {
      expect(PUBLIC_PAGE_PATHS).not.toContain(path);
    }
  });
});
