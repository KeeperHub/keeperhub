import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays } from "./utils/layout";

// Playwright hides scrollbars unless told otherwise. A desktop browser in a
// narrow window shows a classic one beside the page, and it takes width from
// the page: the popover has to line up with the page, not with the window.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

// Phones get the one-month popover under the range buttons, as wide as them.
// From 640 it is the desktop one, 634px wide, which used to be cut off up to
// 681px; 667 is a sideways phone.
const POPOVER_WIDTHS = [320, 390, 430, 600, 640, 667, 1280];
// Tailwind's sm, as BELOW_SM_QUERY in hooks/use-mobile.ts.
const SM = 640;
// Too short for the phone popover below Custom: it keeps to the space there
// and scrolls inside rather than running off the bottom.
const SHORT_PHONE = { width: 390, height: 420 };
// The desktop popover lays out as it always has, even in a short window.
const SHORT_DESKTOP = { width: 1280, height: 400 };
const MONTH_RANGE_REGEX = /^\w{3} 1, \d{4} - \w{3} \d{2}, \d{4}$/;

test.beforeEach(async ({ page }) => {
  await dismissPhoneOverlays(page);
});

function customButton(page: Page): Locator {
  return page.getByRole("button", { name: "Custom date range" });
}

function rangeNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Time range" });
}

function datePopover(page: Page): Locator {
  return page.locator("[data-slot=popover-content]");
}

// Stands in for a long runs table, so the page scrolls whatever the test
// data, and returns the width its scrollbar takes.
function makePageScroll(page: Page): Promise<number> {
  return rangeNav(page).evaluate((nav) => {
    let scroller = nav.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
      scroller = scroller.parentElement;
    }
    if (!scroller) {
      throw new Error("no scrolling ancestor");
    }
    const filler = document.createElement("div");
    filler.style.height = "200vh";
    scroller.append(filler);
    return scroller.offsetWidth - scroller.clientWidth;
  });
}

async function pickThisMonth(page: Page): Promise<void> {
  await customButton(page).click();
  await page.getByRole("button", { name: "This month" }).click();
  await page.keyboard.press("Escape");
  await expect(customButton(page)).toHaveText(MONTH_RANGE_REGEX);
}

async function expectPopoverFits(page: Page, width: number): Promise<void> {
  const phone = width < SM;
  await page.setViewportSize({ width, height: 844 });
  await customButton(page).click();
  const popover = datePopover(page);
  await expect(popover).toBeVisible();
  await expect(popover, `wholly on screen at ${width}px`).toBeInViewport({
    ratio: 1,
  });
  const grids = popover.getByRole("grid");
  await expect(grids).toHaveCount(phone ? 1 : 2);

  await expect(async () => {
    const presets = await box(
      popover.getByRole("button", { name: "This month" })
    );
    const calendar = await box(grids.first());
    if (phone) {
      // Both edges on the range buttons', which take the page's whole width
      // on phones, whatever the scrollbar and however wide Custom's label.
      const found = await box(popover);
      const nav = await box(rangeNav(page));
      expect(
        Math.abs(found.x - nav.x),
        `left edge on the header's at ${width}px`
      ).toBeLessThan(1);
      expect(
        Math.abs(found.x + found.width - (nav.x + nav.width)),
        `right edge on the header's at ${width}px`
      ).toBeLessThan(1);
      expect(presets.y + presets.height).toBeLessThan(calendar.y);
    } else {
      expect(presets.x + presets.width).toBeLessThan(calendar.x);
    }
  }).toPass({ timeout: 5000 });

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
}

test.describe("Analytics Custom date popover", () => {
  test("stays on screen, lined up with the header on phones", async ({
    page,
  }) => {
    await page.setViewportSize({ width: POPOVER_WIDTHS[0], height: 844 });
    await page.goto("/analytics", { waitUntil: "domcontentloaded" });
    await expect(customButton(page)).toBeVisible({ timeout: 15_000 });
    expect(
      await makePageScroll(page),
      "the page shows a scrollbar beside it"
    ).toBeGreaterThan(0);

    for (const width of POPOVER_WIDTHS) {
      await expectPopoverFits(page, width);
    }
    // A picked range makes Custom's label, and the button, much wider.
    await pickThisMonth(page);
    for (const width of POPOVER_WIDTHS) {
      await expectPopoverFits(page, width);
    }

    await page.setViewportSize(SHORT_PHONE);
    await customButton(page).click();
    const popover = datePopover(page);
    await expect(popover, "wholly on a short screen").toBeInViewport({
      ratio: 1,
    });
    expect(
      await popover.evaluate(
        (element) => element.scrollHeight > element.clientHeight
      ),
      "scrolls inside on a short screen"
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();

    await page.setViewportSize(SHORT_DESKTOP);
    await customButton(page).click();
    await expect(popover).toBeVisible();
    expect(
      await popover.evaluate((element) => getComputedStyle(element).overflowY),
      "the desktop popover never scrolls inside"
    ).toBe("visible");
  });
});
