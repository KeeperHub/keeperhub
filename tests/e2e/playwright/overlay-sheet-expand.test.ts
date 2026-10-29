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

type OpenOptions = {
  // Keep the app's announcement banner, which stays above every overlay.
  banner?: boolean;
  testId?: "overlay-sheet" | "overlay-window";
};

async function openConnections(
  page: Page,
  size: { width: number; height: number },
  { banner = false, testId = "overlay-sheet" }: OpenOptions = {}
): Promise<{ sheet: Locator; handle: Locator }> {
  if (banner) {
    await page.addInitScript(() => {
      window.localStorage.setItem("keeperhub-mobile-warning-dismissed", "true");
      window.localStorage.removeItem("kh-billing-announce-v1");
    });
  } else {
    await dismissPhoneOverlays(page);
  }
  await stubData(page);
  await page.setViewportSize(size);
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Added an integration", { exact: false })
    .first()
    .click({ timeout: 30_000 });
  const sheet = page.getByTestId(testId);
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

// The fixed banner's height, 0 when it is not shown.
function bannerHeight(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--app-banner-height"
        )
      ) || 0
  );
}

async function expectFullScreen(
  page: Page,
  sheet: Locator,
  handle: Locator
): Promise<void> {
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  const viewport = page.viewportSize()?.height ?? 0;
  const top = await bannerHeight(page);
  await expect(async () => {
    const sheetBox = await box(sheet);
    expect(Math.round(sheetBox.y)).toBe(top);
    expect(Math.round(sheetBox.y + sheetBox.height)).toBe(viewport);
  }).toPass({ timeout: 5000 });
  // The actions stay on screen at the bottom.
  const done = await box(sheet.getByRole("button", { name: "Done" }));
  expect(done.y + done.height).toBeLessThanOrEqual(viewport);
}

async function expectOwnHeight(
  page: Page,
  sheet: Locator,
  handle: Locator
): Promise<void> {
  await expect(handle).toHaveAttribute("aria-pressed", "false");
  const top = await bannerHeight(page);
  await expect(async () => {
    expect((await box(sheet)).y).toBeGreaterThan(top + 40);
  }).toPass({ timeout: 5000 });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.describe("Overlay sheet on touch phones", () => {
  test.use({ hasTouch: true });

  test("swipes up to full screen, down to its own height, down again to close", async ({
    page,
  }) => {
    const { sheet, handle } = await openConnections(page, PHONE);
    const x = PHONE.width / 2;
    await expectOwnHeight(page, sheet, handle);

    const title = await box(sheet.getByText("Connections", { exact: true }));
    await swipe(page, x, title.y + 10, title.y - 90);
    await expectFullScreen(page, sheet, handle);

    // Full screen, the list scrolls inside the sheet.
    await swipe(page, x, 600, 300);
    await expect.poll(() => contentScroll(sheet)).toBeGreaterThan(0);
    await expect(handle).toHaveAttribute("aria-pressed", "true");

    // A swipe down that starts mid-list only scrolls back to the top.
    await swipe(page, x, 300, 800);
    await expect.poll(() => contentScroll(sheet)).toBe(0);
    await expect(handle).toHaveAttribute("aria-pressed", "true");

    await swipe(page, x, 300, 500);
    await expectOwnHeight(page, sheet, handle);

    const top = (await box(sheet)).y;
    await swipe(page, x, top + 20, PHONE.height - 10);
    await expect(sheet).toBeHidden();
  });

  test("full screen stops under the announcement banner", async ({ page }) => {
    const { sheet, handle } = await openConnections(
      page,
      { width: 360, height: 640 },
      { banner: true }
    );
    const shown = await expect
      .poll(() => bannerHeight(page), { timeout: 5000 })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false);
    test.skip(!shown, "the announcement banner needs billing enabled");
    await handle.click();
    await expectFullScreen(page, sheet, handle);
  });
});

test.describe("Overlay sheet with a mouse", () => {
  test("wheel, the handle and Escape", async ({ page }) => {
    const size = { width: 700, height: 735 };
    const { sheet, handle } = await openConnections(page, size);
    await expectOwnHeight(page, sheet, handle);

    const list = await box(
      sheet.getByText("Sheet connection 1", { exact: true })
    );
    await page.mouse.move(size.width / 2, list.y);
    await page.mouse.wheel(0, 200);
    await expectFullScreen(page, sheet, handle);

    await page.mouse.wheel(0, 400);
    await expect.poll(() => contentScroll(sheet)).toBeGreaterThan(0);
    // A wheel tick right after one that scrolled back to the top (trackpad
    // momentum) does not collapse; one after a pause does. Dispatched in one
    // go so the gap between them is well under the pause.
    await sheet
      .getByText("Sheet connection 1", { exact: true })
      .evaluate((element) => {
        let scroller: Element | null = element;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
          scroller = scroller.parentElement;
        }
        const tick = (): boolean =>
          element.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -100 })
          );
        tick();
        if (scroller) {
          scroller.scrollTop = 0;
        }
        tick();
      });
    expect(await contentScroll(sheet)).toBe(0);
    await expect(handle).toHaveAttribute("aria-pressed", "true");

    // Just past the 300ms pause the guard waits for.
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -200);
    await expect(handle).toHaveAttribute("aria-pressed", "false");
    await expectOwnHeight(page, sheet, handle);

    await handle.click();
    await expectFullScreen(page, sheet, handle);
    await handle.click();
    await expectOwnHeight(page, sheet, handle);

    // Escape closes the sheet from full screen too.
    await handle.click();
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("desktop keeps the centred dialog with its own list box", async ({
    page,
  }) => {
    const { sheet: dialog } = await openConnections(
      page,
      { width: 1280, height: 900 },
      { testId: "overlay-window" }
    );
    await expect(page.getByTestId("overlay-sheet-handle")).toHaveCount(0);
    const listBox = await dialog
      .getByText("Sheet connection 1", { exact: true })
      .evaluate((element) => {
        let node: Element | null = element;
        while (node && getComputedStyle(node).maxHeight === "none") {
          node = node.parentElement;
        }
        return node
          ? {
              maxHeight: getComputedStyle(node).maxHeight,
              overflowY: getComputedStyle(node).overflowY,
            }
          : null;
      });
    expect(listBox).toEqual({ maxHeight: "300px", overflowY: "auto" });
  });
});
