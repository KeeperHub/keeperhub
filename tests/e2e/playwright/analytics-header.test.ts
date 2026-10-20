import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import { ANALYTICS_TEST_EMAIL, ANALYTICS_TEST_PASSWORD } from "./utils/db";
import {
  box,
  dismissPhoneOverlays,
  isOnTop,
  overlaps,
  textFits,
} from "./utils/layout";

// Portrait phones, narrowest to widest, and phones turned sideways.
const NARROW_WIDTHS = [320, 360, 390, 430, 640, 667];
// Sideways phones, where a picked range is too wide for the title's row
// (up to about 690px), so the range buttons and refresh move under it.
const UNDER_TITLE_WIDTHS = [640, 680];
// With the sidebar expanded, the range buttons and refresh no longer fit
// one row even under the title, so the buttons wrap Custom instead.
const EXPANDED_SIDEBAR_WIDTH = 785;
const DESKTOP = { width: 1280, height: 800 };
// Refresh sits right after the range buttons: a few pixels of gap, however
// it is tuned, never pushed across the header.
const BESIDE_MAX_GAP = 32;
// This month's label, "Oct 1, 2026 - Oct 31, 2026": wider than any preset.
const MONTH_RANGE_REGEX = /^\w{3} 1, \d{4} - \w{3} \d{2}, \d{4}$/;
const PAGE_COUNT_REGEX = /^1–50 of [\d,]+$/;
// One line of the count's 12px text; two lines would be at least 32px.
const ONE_LINE_MAX_HEIGHT = 24;

test.beforeEach(async ({ page }) => {
  await dismissPhoneOverlays(page);
});

function refreshButton(page: Page): Locator {
  return page.getByRole("button", { name: "Refresh data" });
}

function customButton(page: Page): Locator {
  return page.getByRole("button", { name: "Custom date range" });
}

function rangeNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Time range" });
}

async function pickThisMonth(page: Page): Promise<void> {
  await customButton(page).click();
  await page.getByRole("button", { name: "This month" }).click();
  await page.keyboard.press("Escape");
  await expect(customButton(page)).toHaveText(MONTH_RANGE_REGEX);
}

function centreY(found: { y: number; height: number }): number {
  return found.y + found.height / 2;
}

async function expectHeaderFits(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await expect
    .poll(() => overlaps(refreshButton(page), customButton(page)), {
      message: `refresh clear of Custom at ${width}px`,
    })
    .toBe(false);
  for (const control of [refreshButton(page), customButton(page)]) {
    await expect(control, `wholly on screen at ${width}px`).toBeInViewport({
      ratio: 1,
    });
    await expect
      .poll(() => isOnTop(control), { message: `tappable at ${width}px` })
      .toBe(true);
  }
}

test.describe("Analytics header", () => {
  test("refresh never covers Custom on narrow screens", async ({ page }) => {
    await page.setViewportSize({ width: NARROW_WIDTHS[0], height: 844 });
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(refreshButton(page)).toBeVisible({ timeout: 15_000 });

    for (const width of NARROW_WIDTHS) {
      await expectHeaderFits(page, width);
    }
    // On phones refresh shares the title's row, above the range buttons.
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await box(refreshButton(page))).y).toBeLessThan(
      (await box(rangeNav(page))).y
    );

    await pickThisMonth(page);
    for (const width of NARROW_WIDTHS) {
      await expectHeaderFits(page, width);
    }
  });

  test("refresh moves under the title with the range buttons, not alone", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(refreshButton(page)).toBeVisible({ timeout: 15_000 });
    await pickThisMonth(page);

    const widths = [...UNDER_TITLE_WIDTHS, EXPANDED_SIDEBAR_WIDTH];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      if (width === EXPANDED_SIDEBAR_WIDTH) {
        const expand = page.getByRole("button", { name: "Expand sidebar" });
        if (await expand.isVisible()) {
          await expand.click();
        }
        await expect(
          page.getByRole("button", { name: "Collapse sidebar" })
        ).toBeVisible();
      }
      await expect(async () => {
        const custom = await box(customButton(page));
        const refresh = await box(refreshButton(page));
        expect(
          Math.abs(centreY(refresh) - centreY(custom)),
          `refresh on Custom's row at ${width}px`
        ).toBeLessThan(1.5);
        expect(refresh.x, `refresh after Custom at ${width}px`).toBeGreaterThan(
          custom.x + custom.width
        );
      }).toPass({ timeout: 5000 });
    }
  });

  test("desktop keeps one row with refresh right after the range buttons", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(refreshButton(page)).toBeVisible({ timeout: 15_000 });

    const nav = await box(rangeNav(page));
    const refresh = await box(refreshButton(page));
    const gap = refresh.x - (nav.x + nav.width);
    expect(gap, "refresh after the range buttons").toBeGreaterThan(0);
    expect(gap, "refresh right beside them").toBeLessThan(BESIDE_MAX_GAP);
    expect(Math.abs(centreY(refresh) - centreY(nav))).toBeLessThan(1.5);
  });
});

test.describe("Workflow Runs card on phones", () => {
  // Signed in as the seeded analytics user rather than the persistent one:
  // only it has more than one page of runs, so only its card shows a count.
  test.use({ storageState: { cookies: [], origins: [] } });

  function runsTable(page: Page): Locator {
    return page.getByTestId("runs-table");
  }

  function title(page: Page): Locator {
    return runsTable(page).getByText("Workflow Runs", { exact: true });
  }

  async function expectTitleRowWhole(page: Page, label: string): Promise<void> {
    const pagination = runsTable(page).getByRole("navigation", {
      name: "Pagination",
    });
    const count = pagination.getByText(PAGE_COUNT_REGEX);
    const previous = pagination.getByRole("button", { name: "Previous page" });
    const next = pagination.getByRole("button", { name: "Next page" });

    await expect(async () => {
      // The card sits below the charts: bring its title row to the middle of
      // the screen, as isOnTop can only hit-test what is in the viewport and
      // the app's fixed top bar covers the first 60px of it.
      await title(page).evaluate((element) =>
        element.scrollIntoView({ block: "center" })
      );
      expect(await textFits(title(page)), `title fits ${label}`).toBe(true);
      expect(await textFits(count), `count fits ${label}`).toBe(true);
      expect(
        (await box(count)).height,
        `count on one line ${label}`
      ).toBeLessThan(ONE_LINE_MAX_HEIGHT);
      expect(
        await overlaps(title(page), count),
        `count clear of title ${label}`
      ).toBe(false);
      expect(
        Math.abs((await box(previous)).y - (await box(next)).y),
        `arrows side by side ${label}`
      ).toBeLessThan(1);
      const card = await box(runsTable(page));
      for (const control of [count, previous, next]) {
        const found = await box(control);
        expect(
          found.x >= card.x &&
            found.y >= card.y &&
            found.x + found.width <= card.x + card.width &&
            found.y + found.height <= card.y + card.height,
          `inside the card ${label}`
        ).toBe(true);
        // A disabled button (Previous on page 1) ignores pointer events, so
        // hit-testing passes through it; only enabled controls can be checked.
        if (await control.isEnabled()) {
          expect(await isOnTop(control), `not covered ${label}`).toBe(true);
        }
      }
    }).toPass({ timeout: 5000 });
  }

  test("the title row stays whole, and Projects takes the card's place", async ({
    page,
  }) => {
    // signIn waits for the header's org switcher, which a phone narrower
    // than 375px keeps in the nav drawer instead, so sign in at desktop width.
    await page.setViewportSize(DESKTOP);
    await signIn(page, ANALYTICS_TEST_EMAIL, ANALYTICS_TEST_PASSWORD);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    const weekOfRuns = page.waitForResponse(
      (response) =>
        response.url().includes("/api/analytics/runs?") &&
        response.url().includes("range=7d")
    );
    await rangeNav(page).getByRole("button", { name: "7d" }).click();
    await weekOfRuns;
    await expect(runsTable(page).getByText(PAGE_COUNT_REGEX)).toBeVisible({
      timeout: 15_000,
    });

    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expectTitleRowWhole(page, `at ${width}px`);
    }

    // Open, the drawer fills the card's width and the card steps aside.
    await page.setViewportSize({ width: 390, height: 844 });
    const projects = runsTable(page).getByRole("button", { name: "Projects" });
    await projects.click();
    const allRuns = runsTable(page).getByRole("button", { name: "All Runs" });
    await expect(allRuns).toBeVisible();
    await expect(allRuns, "focus moves to the current pick").toBeFocused();
    await expect(title(page)).toBeHidden();
    expect((await box(allRuns)).width).toBeGreaterThan(
      (await box(runsTable(page))).width - 40
    );

    // Picking a project closes it, the card is back whole, and focus returns
    // to the Projects button rather than falling to the page.
    await allRuns.click();
    await expect(allRuns).toBeHidden();
    await expect(title(page)).toBeVisible();
    await expect(projects).toBeFocused();
    await expectTitleRowWhole(page, "after picking a project");

    // "Back to runs" closes it without picking.
    await projects.click();
    await runsTable(page).getByRole("button", { name: "Back to runs" }).click();
    await expect(title(page)).toBeVisible();
    await expect(projects).toBeFocused();
  });

  test("from 640px the drawer opens beside the card, as before", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page, ANALYTICS_TEST_EMAIL, ANALYTICS_TEST_PASSWORD);
    await page.setViewportSize({ width: 700, height: 844 });
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(title(page)).toBeVisible({ timeout: 15_000 });

    await runsTable(page).getByRole("button", { name: "Projects" }).click();
    const allRuns = runsTable(page).getByRole("button", { name: "All Runs" });
    await expect(allRuns).toBeVisible();
    await expect(title(page)).toBeVisible();
    expect((await box(title(page))).x).toBeGreaterThan(
      (await box(allRuns)).x + (await box(allRuns)).width
    );

    // Picking a project leaves it open there.
    await allRuns.click();
    await expect(allRuns).toBeVisible();
  });
});
