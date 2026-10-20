import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays, isOnTop, overlaps } from "./utils/layout";

// Portrait phones, narrowest to widest, and phones turned sideways.
const NARROW_WIDTHS = [320, 360, 390, 430, 640, 667];
const DESKTOP = { width: 1280, height: 800 };
// The header's gap-3 between the range buttons and refresh.
const ROW_GAP = 12;
// This month's label, "Oct 1, 2026 - Oct 31, 2026": wider than any preset.
const MONTH_RANGE_REGEX = /^\w{3} 1, \d{4} - \w{3} \d{2}, \d{4}$/;

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
