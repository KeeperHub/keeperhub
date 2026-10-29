import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays } from "./utils/layout";

// Below 768px overlays open as a bottom sheet. Swiping or scrolling up takes it
// full screen; swiping down at the top of its content brings it back, and a
// second swipe down closes it. Opened here the way the activity feed opens
// Connections, with both lists served from stubs.

const PHONE = { width: 390, height: 844 };
const CONNECTION_COUNT = 30;

async function stubData(page: Page): Promise<void> {
  await page.route("**/api/security/audit*", async (route: Route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: "sheet-event",
            action: "integration.created",
            resourceType: "integration",
            resourceId: "sheet-conn-1",
            resourceName: "Discord",
            resourceUser: null,
            version: null,
            diff: null,
            createdAt: new Date().toISOString(),
            metadata: {},
            actor: {
              id: "a",
              name: "Sheet Tester",
              email: "s@example.com",
              role: "owner",
            },
            credential: { authMethod: "session", apiKeyName: null },
          },
        ],
        meta: { total: 1, page: 1, pageSize: 5, totalPages: 1 },
        _links: {},
      },
    });
  });
  await page.route(/\/api\/integrations(\?.*)?$/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const now = new Date().toISOString();
    await route.fulfill({
      json: Array.from({ length: CONNECTION_COUNT }, (_, i) => ({
        id: `sheet-conn-${i + 1}`,
        name: `Sheet connection ${i + 1}`,
        type: "discord",
        createdAt: now,
        updatedAt: now,
      })),
    });
  });
}

async function openConnections(
  page: Page,
  size: { width: number; height: number }
): Promise<{ sheet: Locator; handle: Locator }> {
  await dismissPhoneOverlays(page);
  await stubData(page);
  await page.setViewportSize(size);
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Added an integration", { exact: false })
    .first()
    .click({ timeout: 30_000 });
  const sheet = page.getByTestId("overlay-sheet");
  await expect(
    sheet.getByText("Sheet connection 1", { exact: true })
  ).toBeVisible();
  return { sheet, handle: page.getByTestId("overlay-sheet-handle") };
}

// Raw touch events: Playwright's touchscreen only taps.
async function swipe(
  page: Page,
  x: number,
  fromY: number,
  toY: number
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY }],
  });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

// How far the sheet's content is scrolled.
function contentScroll(sheet: Locator): Promise<number> {
  return sheet
    .getByText("Sheet connection 1", { exact: true })
    .evaluate((element) => {
      let node: Element | null = element;
      while (node && node.scrollHeight <= node.clientHeight) {
        node = node.parentElement;
      }
      return node?.scrollTop ?? 0;
    });
}

async function expectFullScreen(
  page: Page,
  sheet: Locator,
  handle: Locator
): Promise<void> {
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(async () => {
    const sheetBox = await box(sheet);
    expect(Math.round(sheetBox.y)).toBe(0);
    expect(Math.round(sheetBox.height)).toBe(page.viewportSize()?.height);
  }).toPass({ timeout: 5000 });
  // The actions stay on screen at the bottom.
  const done = await box(sheet.getByRole("button", { name: "Done" }));
  expect(done.y + done.height).toBeLessThanOrEqual(PHONE.height);
}

async function expectOwnHeight(sheet: Locator, handle: Locator): Promise<void> {
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect(async () => {
    expect((await box(sheet)).y).toBeGreaterThan(40);
  }).toPass({ timeout: 5000 });
}

test.describe("Overlay sheet on touch phones", () => {
  test.use({ hasTouch: true });

  test("swipes up to full screen, down to its own height, down again to close", async ({
    page,
  }) => {
    const { sheet, handle } = await openConnections(page, PHONE);
    const x = PHONE.width / 2;
    await expectOwnHeight(sheet, handle);

    const title = await box(sheet.getByText("Connections", { exact: true }));
    await swipe(page, x, title.y + 10, title.y - 90);
    await expectFullScreen(page, sheet, handle);

    // Full screen, the list scrolls inside the sheet.
    await swipe(page, x, 600, 300);
    await expect.poll(() => contentScroll(sheet)).toBeGreaterThan(0);
    await expect(handle).toHaveAttribute("aria-expanded", "true");

    // A swipe down that starts mid-list only scrolls back to the top.
    await swipe(page, x, 300, 800);
    await expect.poll(() => contentScroll(sheet)).toBe(0);
    await expect(handle).toHaveAttribute("aria-expanded", "true");

    await swipe(page, x, 300, 500);
    await expectOwnHeight(sheet, handle);

    const top = (await box(sheet)).y;
    await swipe(page, x, top + 20, PHONE.height - 10);
    await expect(sheet).toBeHidden();
  });
});

test.describe("Overlay sheet with a mouse", () => {
  test("wheel and the handle switch full screen on and off", async ({
    page,
  }) => {
    const size = { width: 700, height: 735 };
    const { sheet, handle } = await openConnections(page, size);
    await expectOwnHeight(sheet, handle);

    const list = await box(
      sheet.getByText("Sheet connection 1", { exact: true })
    );
    await page.mouse.move(size.width / 2, list.y);
    await page.mouse.wheel(0, 200);
    await expect(handle).toHaveAttribute("aria-expanded", "true");

    await page.mouse.wheel(0, 400);
    await expect.poll(() => contentScroll(sheet)).toBeGreaterThan(0);
    // Scrolling back up to the top does not collapse in the same motion.
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => contentScroll(sheet)).toBe(0);
    await expect(handle).toHaveAttribute("aria-expanded", "true");

    await expect(async () => {
      await page.mouse.wheel(0, -200);
      await expect(handle).toHaveAttribute("aria-expanded", "false", {
        timeout: 500,
      });
    }).toPass({ timeout: 5000 });

    await handle.click();
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await handle.click();
    await expectOwnHeight(sheet, handle);
  });

  test("desktop keeps the centred dialog with its own list box", async ({
    page,
  }) => {
    const { width, height } = { width: 1280, height: 900 };
    await dismissPhoneOverlays(page);
    await stubData(page);
    await page.setViewportSize({ width, height });
    await page.goto("/activity", { waitUntil: "domcontentloaded" });
    await page
      .getByText("Added an integration")
      .first()
      .click({ timeout: 30_000 });
    const dialog = page.getByTestId("overlay-window");
    await expect(
      dialog.getByText("Sheet connection 1", { exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("overlay-sheet-handle")).toHaveCount(0);
    expect((await box(dialog)).height).toBeLessThan(height * 0.85);
  });
});
