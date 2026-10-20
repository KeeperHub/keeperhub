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
const DESKTOP = { width: 1280, height: 800 };
// The header's gap-3 between the range buttons and refresh.
const ROW_GAP = 12;
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

    // A picked range gives Custom a long label.
    await customButton(page).click();
    await page.getByRole("button", { name: "This month" }).click();
    await page.keyboard.press("Escape");
    await expect(customButton(page)).toHaveText(MONTH_RANGE_REGEX);

    for (const width of NARROW_WIDTHS) {
      await expectHeaderFits(page, width);
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
    expect(Math.abs(refresh.x - (nav.x + nav.width) - ROW_GAP)).toBeLessThan(
      1.5
    );
    expect(
      Math.abs(refresh.y + refresh.height / 2 - (nav.y + nav.height / 2))
    ).toBeLessThan(1.5);
  });
});

// The count's text up to its first line break, as the browser laid it out.
async function firstLineText(locator: Locator): Promise<string> {
  return await locator.evaluate((element) => {
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let firstTop: number | null = null;
    let line = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i += 1) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        // A space the line breaks at can have no box of its own.
        if (rect.width > 0) {
          firstTop ??= rect.top;
          if (rect.top > firstTop + 1) {
            return line.trim();
          }
        }
        line += text[i];
      }
    }
    return line.trim();
  });
}

test.describe("Workflow Runs title row", () => {
  // Signed in as the seeded analytics user rather than the persistent one:
  // only it has more than one page of runs, so only its card shows a count.
  test.use({ storageState: { cookies: [], origins: [] } });

  function pagination(page: Page): Locator {
    return page
      .getByTestId("runs-table")
      .getByRole("navigation", { name: "Pagination" });
  }

  async function expectTitleRowWhole(page: Page, label: string): Promise<void> {
    const card = page.getByTestId("runs-table");
    const count = pagination(page).getByText(PAGE_COUNT_REGEX);
    const title = card.getByText("Workflow Runs", { exact: true });
    const previous = pagination(page).getByRole("button").nth(0);
    const next = pagination(page).getByRole("button").nth(1);

    await expect(async () => {
      expect(await textFits(title), `title fits its box ${label}`).toBe(true);
      expect(await textFits(count), `count fits its box ${label}`).toBe(true);
      expect(
        (await box(count)).height,
        `count on one line ${label}`
      ).toBeLessThan(ONE_LINE_MAX_HEIGHT);
      expect(
        await overlaps(title, count),
        `count clear of title ${label}`
      ).toBe(false);
      expect(
        Math.abs((await box(previous)).y - (await box(next)).y),
        `arrows side by side ${label}`
      ).toBeLessThan(1);
      const cardBox = await box(card);
      for (const control of [count, previous, next]) {
        const controlBox = await box(control);
        expect(
          controlBox.x + controlBox.width,
          `inside the card ${label}`
        ).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      }
    }).toPass({ timeout: 5000 });
  }

  test("the page count stays whole on phones, Projects open or not", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 844 });
    await signIn(page, ANALYTICS_TEST_EMAIL, ANALYTICS_TEST_PASSWORD);
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    const weekOfRuns = page.waitForResponse(
      (response) =>
        response.url().includes("/api/analytics/runs?") &&
        response.url().includes("range=7d")
    );
    await rangeNav(page).getByRole("button", { name: "7d" }).click();
    await weekOfRuns;
    const card = page.getByTestId("runs-table");
    await expect(card.getByText(PAGE_COUNT_REGEX)).toBeVisible({
      timeout: 15_000,
    });

    await expectTitleRowWhole(page, "at 360px");

    await card.getByRole("button", { name: "Projects" }).click();
    await expect(card.getByRole("button", { name: "All Runs" })).toBeVisible();
    // Too narrow for the whole count, it breaks before "of", not inside the
    // range. The title does not fit here: the drawer leaves 42px of card.
    await expect
      .poll(() => firstLineText(pagination(page).getByText(PAGE_COUNT_REGEX)), {
        message: "count's first line at 360px with Projects open",
      })
      .toBe("1–50");
    for (const width of [390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expectTitleRowWhole(page, `at ${width}px with Projects open`);
    }
  });
});
