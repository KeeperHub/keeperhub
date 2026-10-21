import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays, overlaps, textFits } from "./utils/layout";
import { openOrgSettings } from "./utils/settings";

const PHONE_WIDTHS = [320, 390];
const PHONE_HEIGHT = 844;
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };
// Tailwind's md: below it the rail gives way to the menu.
const MD = 768;
const MENU_PATH = "/settings/menu";
const MENU_URL = /\/settings\/menu$/;
const ACCOUNT_URL = /\/settings\/account$/;
// An org-scoped section carries the organization in its path.
const USERS_URL = /\/settings\/[^/]+\/users$/;
// The widest the side gutters get around a section on a phone or tablet.
const MAX_GUTTER = 24;
// In a stacked row the name keeps most of the line; the action cell only
// takes what its buttons need.
const MIN_HEADING_SHARE = 0.5;
// A section's code is compiled on first visit in development.
const FIRST_VISIT = { timeout: 20_000 };

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
  // The first card spans the screen less its gutters: the rail used to take
  // 200px of it, leaving a column a word or two wide.
  const card = main.locator("section").first();
  await expect(card).toBeVisible(FIRST_VISIT);
  const { x, width: cardWidth } = await box(card);
  expect(x).toBeLessThanOrEqual(MAX_GUTTER);
  expect(Math.abs(x - (width - x - cardWidth))).toBeLessThanOrEqual(1);
}

// The members table's header row and its first member, once the list has
// loaded (the skeleton rows before it have no email).
async function membersTable(
  page: Page
): Promise<{ head: Locator; row: Locator }> {
  const table = page.locator("main table").first();
  const row = table.locator("tbody tr").first();
  await expect(row).toContainText("@", FIRST_VISIT);
  return { head: table.locator("thead tr"), row };
}

test.describe("settings on a phone", () => {
  test("opens on the menu, and each section leads back to it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto("/workflows", { waitUntil: "domcontentloaded" });

    await test.step("the drawer's Settings opens the menu", async () => {
      await page.getByTestId("mobile-nav-trigger").click();
      await page.getByTestId("mobile-nav-settings").click();
      await expect(page).toHaveURL(MENU_URL, FIRST_VISIT);
    });

    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible(FIRST_VISIT);
    await expect(page.getByTestId("settings-rail")).toBeHidden();
    await expect(page.getByTestId("settings-back-to-menu")).toHaveCount(0);

    // Org-scoped links get their organization once it has loaded.
    const users = page.getByTestId("settings-menu-users");
    await expect(users).toHaveAttribute("href", USERS_URL, FIRST_VISIT);
    await users.click();
    await expect(page).toHaveURL(USERS_URL, FIRST_VISIT);

    const back = page.getByTestId("settings-back-to-menu");
    await expect(back).toBeVisible(FIRST_VISIT);
    await back.click();
    await expect(page).toHaveURL(MENU_URL, FIRST_VISIT);
    await expect(menu).toBeVisible();
  });

  test("the menu's search leads to a single setting", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto(MENU_PATH, { waitUntil: "domcontentloaded" });

    await page.getByTestId("settings-menu-search").fill("password");
    const match = page.getByTestId("settings-menu-match-security");
    await expect(match).toBeVisible(FIRST_VISIT);
    await expect(page.getByTestId("settings-menu-users")).toHaveCount(0);
  });

  for (const width of PHONE_WIDTHS) {
    test(`sections use the whole screen at ${width}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: PHONE_HEIGHT });

      await test.step("Profile, from /settings", async () => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(ACCOUNT_URL, FIRST_VISIT);
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
      await test.step("a card's title and its search share the header", async () => {
        await openOrgSettings(page, "connections");
        const header = page.locator("main section header").first();
        const title = header.locator("h2");
        const search = header.locator("input");
        await expect(search).toBeVisible(FIRST_VISIT);
        expect(await overlaps(title, search)).toBe(false);
        expect(await textFits(title)).toBe(true);
      });
    });
  }
});

test.describe("tables in a narrow column", () => {
  for (const width of [390, TABLET.width]) {
    test(`stack their rows at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: TABLET.height });
      await openOrgSettings(page, "users");

      const { head, row } = await membersTable(page);
      await expect(head).toBeHidden();
      // What a column header said, the row now says itself.
      await expect(row.getByText("Joined")).toBeVisible();
      const heading = await box(row.locator("td").first());
      const whole = await box(row);
      expect(heading.width / whole.width).toBeGreaterThan(MIN_HEADING_SHARE);
    });
  }

  test("stay tables on a desktop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openOrgSettings(page, "users");

    const { head, row } = await membersTable(page);
    await expect(head).toBeVisible();
    await expect(row.getByText("Joined")).toBeHidden();
  });
});

test.describe("settings on wider screens", () => {
  for (const size of [TABLET, DESKTOP]) {
    test(`keep the rail and go straight to a section at ${size.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(ACCOUNT_URL, FIRST_VISIT);
      await expect(page.getByTestId("settings-rail")).toBeVisible();
      await expect(page.getByTestId("settings-back-to-menu")).toBeHidden();

      // The phone's menu has nothing to add beside the rail.
      await page.goto(MENU_PATH, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(ACCOUNT_URL, FIRST_VISIT);
      await expect(page.getByTestId("settings-rail")).toBeVisible();
    });
  }

  test("the rail and the way back to the menu meet at md", async ({ page }) => {
    for (const width of [MD - 1, MD]) {
      await page.setViewportSize({ width, height: TABLET.height });
      await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
      const rail = page.getByTestId("settings-rail");
      const back = page.getByTestId("settings-back-to-menu");
      // Exactly one of them, so no width is left without either.
      await expect(width < MD ? back : rail).toBeVisible(FIRST_VISIT);
      await expect(width < MD ? rail : back).toBeHidden();
    }
  });

  test("a plan's two figures do not run into each other", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openOrgSettings(page, "plans");

    // Each figure's box stayed inside its half of the row while the number
    // itself spilled out of it into the other one, so the text is what is
    // measured, not just the boxes.
    const figures = page.locator(".khp-metric-value");
    await expect(figures.first()).toBeVisible(FIRST_VISIT);
    for (const figure of await figures.all()) {
      expect(await textFits(figure)).toBe(true);
    }
    let pairs = 0;
    for (const metricsBox of await page.locator(".khp-metrics-box").all()) {
      const pair = metricsBox.locator(".khp-metric-value");
      if ((await pair.count()) === 2) {
        expect(await overlaps(pair.nth(0), pair.nth(1))).toBe(false);
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
});
