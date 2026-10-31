import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_INVITER_EMAIL,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import {
  type Box,
  box,
  dismissPhoneOverlays,
  isOnTop,
  overlaps,
  textFits,
} from "./utils/layout";

// Use template on a public workflow someone else owns: a bar at the bottom
// of the canvas, never in the header.
const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const WIDE_WIDTHS = [768, 1024, 1280, 1920] as const;
const HEIGHT = 844;

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;

async function open(page: Page, width: number, id: string): Promise<void> {
  await dismissPhoneOverlays(page);
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`/workflows/${id}`, { waitUntil: "domcontentloaded" });
}

async function atWidth(
  page: Page,
  width: number,
  check: () => Promise<void>
): Promise<void> {
  await test.step(`${width}px`, async () => {
    await page.setViewportSize({ width, height: HEIGHT });
    await expect(check).toPass({ timeout: 10_000 });
  });
}

function templateButton(page: Page): Locator {
  return page.getByRole("button", { name: "Use this workflow as a template" });
}

// Every control in the header's left side is clear of the right side's.
async function headerControlsApart(page: Page): Promise<void> {
  const boxesIn = async (testId: string): Promise<Box[]> =>
    await page
      .getByTestId(testId)
      .locator("button:visible, a:visible")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
      );
  const [left, rightSide] = await Promise.all([
    boxesIn("header-left"),
    boxesIn("header-right"),
  ]);
  for (const a of left) {
    for (const b of rightSide) {
      expect(await overlaps(a, b)).toBe(false);
    }
  }
}

// A toast shown meanwhile (the paid-features notice, say) sits above the bar.
async function toastsClear(page: Page, barBox: Box): Promise<void> {
  const toasts = await page.locator("[data-sonner-toast]:visible").all();
  for (const toast of toasts) {
    expect(await overlaps(await box(toast), barBox)).toBe(false);
  }
}

async function expectPhoneBar(page: Page, width: number): Promise<void> {
  const button = templateButton(page);
  const bar = page.getByTestId("use-template-bar");
  await expect(button).toBeVisible();
  await expect(page.getByTestId("header-left").locator(button)).toHaveCount(0);
  const [barBox, buttonBox, header, controls] = await Promise.all([
    box(bar),
    box(button),
    box(page.getByTestId("header-right")),
    box(page.locator(".workflow-controls-panel")),
  ]);
  // Inside the screen, at its bottom, below the zoom controls.
  expect(barBox.x).toBeGreaterThanOrEqual(12);
  expect(right(barBox)).toBeLessThanOrEqual(width - 12);
  expect(bottom(barBox)).toBeLessThanOrEqual(HEIGHT - 16);
  expect(bottom(barBox)).toBeGreaterThan(HEIGHT - 40);
  expect(barBox.y).toBeGreaterThan(bottom(header));
  expect(await overlaps(barBox, controls)).toBe(false);
  expect(right(buttonBox)).toBeLessThanOrEqual(right(barBox));
  expect(await isOnTop(button)).toBe(true);
  expect(await textFits(button)).toBe(true);
  await toastsClear(page, barBox);
  await headerControlsApart(page);
}

test.describe("Use template bar, signed in", () => {
  let foreignId = "";
  let ownId = "";

  test.beforeAll(async () => {
    const foreign = await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
      name: "Use template bar source",
      hub: {},
    });
    foreignId = foreign.id;
    const own = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: "Use template bar own",
      hub: {},
    });
    ownId = own.id;
  });

  test.afterAll(async () => {
    for (const id of [foreignId, ownId]) {
      if (id) {
        await deleteTestWorkflow(id);
      }
    }
  });

  test("phones: at the bottom of the screen, header clear", async ({
    page,
  }) => {
    await open(page, PHONE_WIDTHS[0], foreignId);
    await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
    for (const width of PHONE_WIDTHS) {
      await atWidth(page, width, () => expectPhoneBar(page, width));
    }
  });

  test("from 768px: centred over the canvas, clear of the controls", async ({
    page,
  }) => {
    await open(page, WIDE_WIDTHS[0], foreignId);
    await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, async () => {
        const button = templateButton(page);
        const panel = page.getByTestId("use-template-bar").locator("> div");
        await expect(
          page.getByTestId("header-left").locator(button)
        ).toHaveCount(0);
        const [barBox, canvas, controls] = await Promise.all([
          box(panel),
          box(page.getByTestId("workflow-canvas")),
          box(page.locator(".workflow-controls-panel")),
        ]);
        // The canvas runs under the sidebar; its free part starts at the
        // nav's right edge and ends at the right panel.
        const navEdge = await page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--nav-content-offset"
            )
          )
        );
        const middle = (navEdge + right(canvas)) / 2;
        expect(Math.abs(barBox.x + barBox.width / 2 - middle)).toBeLessThan(2);
        expect(bottom(barBox)).toBeLessThanOrEqual(HEIGHT - 16);
        expect(await overlaps(barBox, controls)).toBe(false);
        expect(await isOnTop(button)).toBe(true);
        expect(await textFits(button)).toBe(true);
        await toastsClear(page, barBox);
        await headerControlsApart(page);
      });
    }
  });

  test("not shown on your own workflow", async ({ page }) => {
    await open(page, 390, ownId);
    await expect(page.getByTestId("workflow-canvas")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("workflow-actions")).toBeVisible();
    await expect(templateButton(page)).toHaveCount(0);
  });
});

test.describe("Use template bar, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let foreignId = "";

  test.beforeAll(async () => {
    const foreign = await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
      name: "Use template bar visitor",
      hub: {},
    });
    foreignId = foreign.id;
  });

  test.afterAll(async () => {
    if (foreignId) {
      await deleteTestWorkflow(foreignId);
    }
  });

  test("phones: the bar opens the sign-in window", async ({ page }) => {
    await open(page, 390, foreignId);
    await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
    await expectPhoneBar(page, 390);
    await templateButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
