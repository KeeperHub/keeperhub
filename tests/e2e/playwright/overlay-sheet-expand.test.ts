import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, dismissPhoneOverlays } from "./utils/layout";

// Below 768px overlays open as a bottom sheet. Swiping up or a wheel down takes
// it full screen; swiping down or a wheel up at the top of its content brings
// it back, and a second swipe down closes it. Opened here the way the activity feed opens
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
  testId?: "overlay-sheet" | "overlay-window";
};

async function openConnections(
  page: Page,
  size: { width: number; height: number },
  { testId = "overlay-sheet" }: OpenOptions = {}
): Promise<{ sheet: Locator; handle: Locator }> {
  await dismissPhoneOverlays(page);
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

// Raw touch events: Playwright's touchscreen only taps. One finger through
// each y in turn, then lifted.
async function swipe(page: Page, x: number, ...ys: number[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: ys[0] ?? 0 }],
  });
  const steps = 8;
  for (const [index, toY] of ys.slice(1).entries()) {
    const fromY = ys[index] ?? toY;
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }],
      });
    }
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

// Stands in for an on-screen keyboard covering the bottom of the page: what
// the browser reports through visualViewport, which the sheet sizes from.
async function fakeKeyboard(page: Page, covered: number): Promise<void> {
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - height,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, covered);
}

// The element the connection list scrolls in: how far it is scrolled, its box
// rules, and whether the filter above the list scrolls with it.
function listScroller(sheet: Locator): Promise<{
  scrollTop: number;
  maxHeight: string;
  overflowY: string;
  holdsFilter: boolean;
}> {
  return sheet
    .getByText("Sheet connection 1", { exact: true })
    .evaluate((element) => {
      let node: Element | null = element;
      while (node && node.scrollHeight <= node.clientHeight) {
        node = node.parentElement;
      }
      const style = node ? getComputedStyle(node) : null;
      return {
        scrollTop: node?.scrollTop ?? 0,
        maxHeight: style?.maxHeight ?? "",
        overflowY: style?.overflowY ?? "",
        holdsFilter: Boolean(node?.querySelector("input")),
      };
    });
}

async function contentScroll(sheet: Locator): Promise<number> {
  return (await listScroller(sheet)).scrollTop;
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
    // The list scrolls with the sheet's content, not in a box of its own.
    expect((await listScroller(sheet)).holdsFilter).toBe(true);

    // One gesture up (full screen) and back down past where it started only
    // switches to full screen; it does not close the sheet.
    const title = await box(sheet.getByText("Connections", { exact: true }));
    await swipe(page, x, title.y + 10, title.y - 30, title.y + 250);
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

  test("full screen stops under the app banner", async ({ page }) => {
    const { sheet, handle } = await openConnections(page, {
      width: 360,
      height: 640,
    });
    // The banner sets this while it shows; set here so billing need not be on.
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--app-banner-height", "36px")
    );
    await handle.click();
    await expectFullScreen(page, sheet, handle);
  });

  test("an on-screen keyboard leaves the actions above it", async ({
    page,
  }) => {
    const { sheet, handle } = await openConnections(page, PHONE);
    const done = sheet.getByRole("button", { name: "Done" });
    const keyboard = 300;
    const visible = PHONE.height - keyboard;
    await sheet.getByPlaceholder("Filter connections...").focus();
    await fakeKeyboard(page, keyboard);

    // At its own height the long list shrinks to fit; it does not push the
    // actions under the keyboard.
    await expect(async () => {
      const doneBox = await box(done);
      expect(doneBox.y + doneBox.height).toBeLessThanOrEqual(visible);
      expect((await box(sheet)).y).toBeGreaterThanOrEqual(0);
    }).toPass({ timeout: 5000 });

    await handle.click();
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      const sheetBox = await box(sheet);
      expect(Math.round(sheetBox.y)).toBe(0);
      expect(Math.round(sheetBox.y + sheetBox.height)).toBe(visible);
      const doneBox = await box(done);
      expect(doneBox.y + doneBox.height).toBeLessThanOrEqual(visible);
    }).toPass({ timeout: 5000 });

    await fakeKeyboard(page, 0);
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
    // Trackpad momentum: wheel-up ticks 50ms apart keep coming for most of a
    // second after the list is back at its top. None of them collapse.
    await sheet
      .getByText("Sheet connection 1", { exact: true })
      .evaluate(async (element) => {
        let scroller: Element | null = element;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
          scroller = scroller.parentElement;
        }
        for (let tick = 0; tick < 20; tick++) {
          element.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -40 })
          );
          if (scroller) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - 150);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
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
    expect(await listScroller(dialog)).toMatchObject({
      maxHeight: "300px",
      overflowY: "auto",
      holdsFilter: false,
    });
  });
});
