import type { Locator, Page } from "@playwright/test";
import { createWebhookTriggerNode } from "../../fixtures/workflows";
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

// Use template on a public workflow someone else owns: a bar across the
// bottom of the free canvas, never in the header, never on other controls.
const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const WIDE_WIDTHS = [768, 1024, 1280, 1920] as const;
const HEIGHT = 844;
const RE_URL_DELIMS = /[/?#]/;

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;
const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  right(inner) <= right(outer) + 0.5 &&
  bottom(inner) <= bottom(outer) + 0.5;

function templateButton(page: Page): Locator {
  return page.getByRole("button", { name: "Use template", exact: true });
}

function card(page: Page): Locator {
  return page.locator("[data-use-template-bar]");
}

// panelWidth: the right panel's width in %, as its resize handle saves it.
async function open(
  page: Page,
  width: number,
  id: string,
  panelWidth?: number
): Promise<void> {
  await dismissPhoneOverlays(page);
  if (panelWidth) {
    await page.context().addCookies([
      {
        name: "sidebar-width",
        value: String(panelWidth),
        url: process.env.BASE_URL || "http://localhost:3000",
      },
    ]);
  }
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`/workflows/${id}`, { waitUntil: "domcontentloaded" });
  await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
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

// Every corner (3px in, past the rounding, which hit testing follows) and the
// centre of the element are drawn on top.
async function wholyOnTop(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const points = [
      [r.left + 3, r.top + 3],
      [r.right - 3, r.top + 3],
      [r.left + 3, r.bottom - 3],
      [r.right - 3, r.bottom - 3],
      [r.left + r.width / 2, r.top + r.height / 2],
    ];
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit);
    });
  });
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

// The button, and the badge when shown, inside the card; the card clear of
// the zoom controls (and minimap) and of the header; no sideways scroll.
async function expectCardSound(page: Page): Promise<Box> {
  const button = templateButton(page);
  await expect(
    page.getByTestId("header-left").getByRole("button", {
      name: "Use template",
      exact: true,
    })
  ).toHaveCount(0);
  const [cardBox, buttonBox, controls, header] = await Promise.all([
    box(card(page)),
    box(button),
    box(page.locator(".workflow-controls-panel")),
    box(page.getByTestId("header-right")),
  ]);
  expect(inside(buttonBox, cardBox)).toBe(true);
  const badge = card(page).getByText("Preview", { exact: true });
  if (await badge.isVisible()) {
    expect(inside(await box(badge), cardBox)).toBe(true);
  }
  expect(await overlaps(cardBox, controls)).toBe(false);
  expect(cardBox.y).toBeGreaterThan(bottom(header));
  expect(bottom(cardBox)).toBeLessThanOrEqual(HEIGHT - 16 + 0.5);
  expect(await wholyOnTop(button)).toBe(true);
  expect(await textFits(button)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    )
  ).toBeLessThanOrEqual(0);
  await headerControlsApart(page);
  return cardBox;
}

async function expectPhoneBar(page: Page, width: number): Promise<void> {
  const cardBox = await expectCardSound(page);
  expect(cardBox.x).toBeGreaterThanOrEqual(12);
  expect(right(cardBox)).toBeLessThanOrEqual(width - 12);
}

// From md the card is centred on the canvas left free between the sidebar
// (with any open flyout) and the right panel, 16px inside it.
async function expectWideBar(page: Page): Promise<void> {
  if (!(await templateButton(page).isVisible())) {
    // A canvas narrower than the card (a flyout over it) hides the card.
    await expect(card(page)).toBeHidden();
    return;
  }
  const cardBox = await expectCardSound(page);
  const canvas = await box(page.getByTestId("workflow-canvas"));
  const navEdge = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Number.parseFloat(
      style.getPropertyValue("--nav-content-offset") ||
        style.getPropertyValue("--nav-sidebar-width")
    );
  });
  expect(Number.isFinite(navEdge)).toBe(true);
  const freeLeft = navEdge + 16;
  const freeRight = right(canvas) - 16;
  expect(cardBox.x).toBeGreaterThanOrEqual(freeLeft - 0.5);
  expect(right(cardBox)).toBeLessThanOrEqual(freeRight + 0.5);
  const middle = (freeLeft + freeRight) / 2;
  expect(Math.abs(cardBox.x + cardBox.width / 2 - middle)).toBeLessThan(2);
}

test.describe("Use template bar, signed in", () => {
  const ids: string[] = [];
  let foreignId = "";
  let ownId = "";
  let copyableId = "";

  test.beforeAll(async () => {
    foreignId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar source",
        hub: {},
      })
    ).id;
    ownId = (
      await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name: "Use template bar own",
        hub: {},
      })
    ).id;
    // A trigger alone: copying it needs no paid plan.
    copyableId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar copyable",
        hub: {},
        nodes: [createWebhookTriggerNode()],
        edges: [],
      })
    ).id;
    ids.push(foreignId, ownId, copyableId);
  });

  test.afterAll(async () => {
    for (const id of ids) {
      await deleteTestWorkflow(id);
    }
  });

  test("phones: at the bottom of the screen, header clear", async ({
    page,
  }) => {
    await open(page, PHONE_WIDTHS[0], foreignId);
    for (const width of PHONE_WIDTHS) {
      await atWidth(page, width, () => expectPhoneBar(page, width));
    }
  });

  test("from 768px: centred on the free canvas, clear of the controls", async ({
    page,
  }) => {
    await open(page, WIDE_WIDTHS[0], foreignId);
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () => expectWideBar(page));
    }
  });

  test("from 768px: a 50% right panel and the minimap", async ({ page }) => {
    await open(page, WIDE_WIDTHS[0], foreignId, 50);
    await page.getByTitle("Show minimap").click();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () => expectWideBar(page));
    }
  });

  test("from 768px: with the Workflows flyout open", async ({ page }) => {
    await open(page, WIDE_WIDTHS[0], foreignId);
    const flyout = page.getByRole("region", { name: "Workflows" });
    if (!(await flyout.isVisible())) {
      await page.getByTestId("nav-workflows").click();
    }
    await expect(flyout).toBeVisible();
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () => expectWideBar(page));
    }
  });

  test("a toast shown meanwhile sits above the bar", async ({ page }) => {
    await open(page, 390, foreignId);
    // The source has a paid step: the paid-features notice, when billing is on.
    const toast = page.locator("[data-sonner-toast]").first();
    const shown = await toast
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!shown, "No toast on this deployment (billing off)");
    for (const width of [390, 1024]) {
      await atWidth(page, width, async () => {
        expect(await overlaps(await box(toast), await box(card(page)))).toBe(
          false
        );
      });
    }
  });

  test("copies the workflow and opens the copy", async ({ page }) => {
    await open(page, 1280, copyableId);
    await templateButton(page).click();
    await expect(page).not.toHaveURL(new RegExp(copyableId), {
      timeout: 15_000,
    });
    const copyId = page.url().split("/workflows/")[1]?.split(RE_URL_DELIMS)[0];
    if (copyId) {
      ids.push(copyId);
    }
    await expect(page.getByTestId("workflow-actions")).toBeVisible({
      timeout: 15_000,
    });
    await expect(card(page)).toHaveCount(0);
  });

  test("not shown on your own workflow", async ({ page }) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`/workflows/${ownId}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workflow-actions")).toBeVisible({
        timeout: 15_000,
      });
      await expect(card(page)).toHaveCount(0);
    }
  });
});

test.describe("Use template bar, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let foreignId = "";

  test.beforeAll(async () => {
    foreignId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar visitor",
        hub: {},
      })
    ).id;
  });

  test.afterAll(async () => {
    if (foreignId) {
      await deleteTestWorkflow(foreignId);
    }
  });

  test("phones: the bar opens the sign-in window", async ({ page }) => {
    await open(page, 390, foreignId);
    await expectPhoneBar(page, 390);
    await templateButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await isOnTop(page.getByRole("dialog"))).toBe(true);
  });
});
