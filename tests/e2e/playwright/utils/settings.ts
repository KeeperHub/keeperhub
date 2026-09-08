import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Open an organization-scoped settings section.
 *
 * The rail builds its org-scoped links from the active organization, which
 * loads after the first paint. Following one before it resolves lands on
 * `/settings/<segment>`, where the app reads the segment as an organization id.
 * So the link is read back from the page once it carries an id, rather than
 * clicked on sight or built from an id the test does not hold.
 */
export async function openOrgSettings(
  page: Page,
  segment: string
): Promise<void> {
  await page.goto("/settings/account", { waitUntil: "domcontentloaded" });

  const pattern = new RegExp(`^/settings/[^/]+/${segment}$`);
  let href: string | null = null;
  await expect
    .poll(
      async () => {
        const hrefs = await page.$$eval("a[href]", (anchors) =>
          anchors.map((a) => a.getAttribute("href") ?? "")
        );
        href = hrefs.find((h) => pattern.test(h)) ?? null;
        return href;
      },
      { timeout: 20_000 }
    )
    .not.toBeNull();

  await page.goto(href as unknown as string, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(new RegExp(`/settings/[^/]+/${segment}`), {
    timeout: 20_000,
  });
}
