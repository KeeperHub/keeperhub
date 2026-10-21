import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays, overlaps } from "./utils/layout";
import { openOrgSettings } from "./utils/settings";

const PHONE_WIDTHS = [320, 390];
const PHONE_HEIGHT = 844;
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };
const MENU_URL = /\/settings$/;
const ACCOUNT_URL = /\/settings\/account$/;
// An org-scoped section carries the organization in its path.
const USERS_URL = /\/settings\/[^/]+\/users$/;
// The content column's side padding on a phone (px-4).
const PHONE_GUTTER = 16;

// These tests are about the settings layout, not what sits over it.
test.beforeEach(async ({ page }) => {
  await dismissPhoneOverlays(page);
});

async function contentFitsWidth(page: Page, width: number): Promise<void> {
  const main = page.getByTestId("settings-shell").locator("main");
  await expect
    .poll(() =>
      main.evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
    .toBe(true);
  // The first card spans the screen less the gutters: the rail used to take
  // 200px of it, leaving a column a word or two wide.
  const card = main.locator("section").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const { x, width: cardWidth } = await box(card);
  expect(x).toBe(PHONE_GUTTER);
  expect(cardWidth).toBe(width - 2 * PHONE_GUTTER);
}

test.describe("settings on a phone", () => {
  test("opens on the menu, and each section leads back to it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto("/settings", { waitUntil: "domcontentloaded" });

    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(MENU_URL);
    await expect(page.getByTestId("settings-rail")).toBeHidden();
    await expect(page.getByTestId("settings-back-to-menu")).toHaveCount(0);

    // Org-scoped links get their organization once it has loaded.
    const users = page.getByTestId("settings-menu-users");
    await expect(users).toHaveAttribute("href", USERS_URL, {
      timeout: 20_000,
    });
    await users.click();
    await expect(page).toHaveURL(USERS_URL);

    const back = page.getByTestId("settings-back-to-menu");
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(MENU_URL);
    await expect(menu).toBeVisible();
  });

  test("the menu's search leads to a single setting", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto("/settings", { waitUntil: "domcontentloaded" });

    await page.getByTestId("settings-menu-search").fill("password");
    const match = page.getByTestId("settings-menu-match-security");
    await expect(match).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("settings-menu-users")).toHaveCount(0);
  });

  for (const width of PHONE_WIDTHS) {
    test(`sections use the whole screen at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: PHONE_HEIGHT });

      await test.step("Profile", async () => {
        await page.goto("/settings/account", {
          waitUntil: "domcontentloaded",
        });
        await contentFitsWidth(page, width);
      });
      await test.step("Account security", async () => {
        await page.goto("/settings/security", {
          waitUntil: "domcontentloaded",
        });
        await contentFitsWidth(page, width);
      });
      await test.step("Users", async () => {
        await openOrgSettings(page, "users");
        await contentFitsWidth(page, width);
      });
    });
  }
});

test.describe("settings on wider screens", () => {
  for (const size of [TABLET, DESKTOP]) {
    test(`keeps the rail and has no menu page at ${size.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/settings", { waitUntil: "domcontentloaded" });

      await expect(page).toHaveURL(ACCOUNT_URL, { timeout: 20_000 });
      await expect(page.getByTestId("settings-rail")).toBeVisible();
      await expect(page.getByTestId("settings-back-to-menu")).toBeHidden();
      await expect(page.getByTestId("settings-menu")).toHaveCount(0);
    });
  }

  test("a plan's two figures do not run into each other", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openOrgSettings(page, "plans");

    const boxes = page.locator(".khp-metrics-box");
    await expect(boxes.first()).toBeVisible({ timeout: 20_000 });
    for (const metricsBox of await boxes.all()) {
      const figures = metricsBox.locator(".khp-metric-value");
      if ((await figures.count()) === 2) {
        expect(await overlaps(figures.nth(0), figures.nth(1))).toBe(false);
      }
    }
  });
});
