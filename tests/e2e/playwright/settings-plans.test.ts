import type { Locator, Page, Route } from "@playwright/test";
import { OWNER_ONLY_LINE } from "@/components/settings/hub/plans-description";
import { expect, test } from "./fixtures";
import { openOrgSettings } from "./utils/settings";

const FIRST_VISIT = { timeout: 20_000 };
// Long enough for the page to be on screen and usable before it arrives.
const LATE = 3000;

/** Holds every request to `url` until the returned function is called. */
async function holdRequests(page: Page, url: string): Promise<() => void> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route: Route) => {
    await released;
    await route.fallback();
  });
  return release;
}

function annualButton(page: Page): Locator {
  return page.locator(".khp-interval-btn", { hasText: "Annual" });
}

test.describe("the plans page while it loads", () => {
  test("an owner is never told only the owner can change the plan", async ({
    page,
  }) => {
    // The role comes from the organizations list, or from the active
    // membership until the list arrives; slow ones leave the page on screen
    // without it for a while.
    for (const url of [
      "**/api/organizations",
      "**/api/auth/organization/get-full-organization*",
    ]) {
      await page.route(url, async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, LATE));
        await route.fallback();
      });
    }
    await page.addInitScript((line) => {
      const seen = (): void => {
        if (document.body?.innerText.includes(line)) {
          (window as unknown as { ownerOnlySeen: boolean }).ownerOnlySeen =
            true;
        }
      };
      new MutationObserver(seen).observe(document, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }, OWNER_ONLY_LINE);

    await openOrgSettings(page, "plans");
    // The plan buttons turn on once the role says this is the owner.
    await expect(
      page.locator('.khp-cta:not([aria-disabled="true"])').first()
    ).toBeVisible(FIRST_VISIT);

    const seen = await page.evaluate(
      () =>
        (window as unknown as { ownerOnlySeen?: boolean }).ownerOnlySeen ??
        false
    );
    expect(seen).toBe(false);
  });

  test("a billing period picked before the plan loads stays picked", async ({
    page,
  }) => {
    // A paid plan, so its arrival changes the current card and remounts the
    // table.
    await page.route("**/api/billing/subscription", (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          subscription: {
            plan: "pro",
            tier: "25k",
            interval: null,
            status: "active",
          },
        }),
      })
    );
    // Registered last, so it runs first and holds the answer above back.
    const release = await holdRequests(page, "**/api/billing/subscription");

    await openOrgSettings(page, "plans");
    const annual = annualButton(page);
    await expect(annual).toBeVisible(FIRST_VISIT);
    // A click before the page hydrates does nothing, so it is repeated until
    // it takes.
    await expect(async () => {
      await annual.click();
      await expect(annual).toHaveClass(/khp-interval-btn--active/, {
        timeout: 1000,
      });
    }).toPass(FIRST_VISIT);

    release();
    const pro = page
      .locator(".khp-card")
      .filter({ has: page.locator(".khp-card-name", { hasText: /^Pro$/ }) });
    await expect(pro.locator(".khp-card-badge")).toHaveText(/current/i, {
      timeout: FIRST_VISIT.timeout,
    });
    await expect(annual).toHaveClass(/khp-interval-btn--active/);
  });
});
