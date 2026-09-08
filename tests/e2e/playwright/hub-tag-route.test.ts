import { expect, test } from "./fixtures";

// Force a fresh anonymous context — tag pages must render for everyone,
// regardless of session state.
test.use({ storageState: { cookies: [], origins: [] } });

// Subset of reserved slugs that the route handler MUST 404. We intentionally
// skip `_next`, `og`, and `well-known` because Next's middleware/static
// asset routing intercepts those segments before our [tag] handler — the
// HUB-15 contract is enforced at the validator level (covered by the
// reserved-slugs unit tests). The route-level 404 invariant is covered by
// the slugs the user can actually request as URLs.
const RESERVED_SLUGS_FOR_ROUTE = [
  "tags",
  "protocol",
  "marketplace",
  "auth",
  "api",
  "admin",
];

const RE_NON_REGEX = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(RE_NON_REGEX, "\\$&");
}

type TagRow = {
  id: string;
  slug: string;
  name: string;
  workflowCount?: number;
};

test.describe("Hub tag route (HUB-08, HUB-11, HUB-14)", () => {
  test("returns 404 for an unknown slug", async ({ page }) => {
    const res = await page.goto(
      "/hub/tags/nope-this-tag-does-not-exist-99999",
      { waitUntil: "domcontentloaded" }
    );
    expect(res?.status()).toBe(404);
  });

  for (const reserved of RESERVED_SLUGS_FOR_ROUTE) {
    test(`returns 404 for reserved slug: ${reserved}`, async ({ page }) => {
      const res = await page.goto(`/hub/tags/${reserved}`, {
        waitUntil: "domcontentloaded",
      });
      expect(res?.status()).toBe(404);
    });
  }

  test("returns 200 with tag-aware metadata for a seeded public tag", async ({
    page,
  }) => {
    // Pull the first public tag from the JSON API; if the seed is empty,
    // skip the assertion with a documented reason.
    const tagsRes = await page.request.get("/api/public-tags");
    if (!tagsRes.ok()) {
      test.skip(
        true,
        `Public tags endpoint unavailable (status ${tagsRes.status()})`
      );
    }
    const tagList = (await tagsRes.json()) as TagRow[];
    if (!tagList || tagList.length === 0) {
      test.skip(true, "No seeded public tags — run pnpm db:seed first");
    }
    const seeded = tagList[0];
    if (!seeded) {
      test.skip(true, "Public tags response was empty");
      return;
    }

    const res = await page.goto(`/hub/tags/${seeded.slug}`, {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBe(200);

    // Title contract per UI-SPEC section 6 / generateMetadata in
    // app/hub/tags/[tag]/page.tsx
    await expect(page).toHaveTitle(
      new RegExp(`${escapeRegex(seeded.name)} templates · KeeperHub Hub`)
    );

    // Canonical link present + correctly pointing
    const canonicalHref = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    expect(canonicalHref).toContain(`/hub/tags/${seeded.slug}`);
  });
});
