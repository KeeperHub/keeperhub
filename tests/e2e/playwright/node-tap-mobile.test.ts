import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { box, dismissPhoneOverlays } from "./utils/layout";
import { waitForCanvas } from "./utils/workflow";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
// Above any sheet (they stop at 90vh), on the backdrop.
const BACKDROP = { x: PHONE.width / 2, y: 40 };
const NEW_STEP = '.react-flow__node-action.selected:not([data-id="action-1"])';

test.use({ hasTouch: true });

async function openWorkflow(
  page: Page,
  size: { width: number; height: number }
): Promise<string> {
  const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
    name: `node-tap-${size.width}-${Date.now()}`,
    triggerType: "manual",
    enabled: false,
  });
  await dismissPhoneOverlays(page);
  await page.setViewportSize(size);
  await page.goto(`/workflows/${workflow.id}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCanvas(page);
  // The owner's toolbar shows once the workflow has loaded.
  await expect(page.getByTitle("Configuration", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  return workflow.id;
}

// Scoped to the sheet: the hidden side panel has its own #label and picker.
function sheet(page: Page): Locator {
  return page.getByRole("dialog", { name: "Configuration" });
}

// The Configuration sheet, found by its Close button (a drawer on phones).
function sheetClose(page: Page): Locator {
  return page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true });
}

type SheetPress = {
  sheetOpenedAt: number;
  pressedAt: number;
  pressOnSheet: boolean;
  pressDropped: boolean;
};

// In the page: when the sheet appears, and the first press after that, with
// whether it landed on the sheet and whether the sheet dropped it.
function trackSheetAndNextPress(): void {
  const w = window as unknown as SheetPress;
  w.sheetOpenedAt = 0;
  w.pressedAt = 0;
  w.pressOnSheet = false;
  w.pressDropped = false;
  const openSheet = () =>
    document.querySelector('[role="dialog"][data-state="open"]');
  new MutationObserver((_, observer) => {
    if (openSheet()) {
      w.sheetOpenedAt = performance.now();
      observer.disconnect();
    }
  }).observe(document.body, {
    attributeFilter: ["data-state"],
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      const sheetNode = openSheet();
      if (sheetNode && w.sheetOpenedAt && !w.pressedAt) {
        w.pressedAt = event.timeStamp;
        w.pressOnSheet = sheetNode.contains(event.target as Node);
        // Read once the event has gone through the page's handlers.
        setTimeout(() => {
          w.pressDropped = event.defaultPrevented;
        }, 0);
      }
    },
    { capture: true }
  );
}

// A one-finger drag, as React Flow sees it from a real touch screen.
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (t: number) => [
    { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: at(0),
  });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(step / 10),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe("Tapping a step opens its settings", () => {
  test("on a phone, in the Configuration sheet on Properties", async ({
    page,
  }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      // Leave the sheet on Runs, so the tap has to bring Properties back.
      await page.getByTitle("Configuration", { exact: true }).tap();
      await page.getByRole("button", { name: "Runs", exact: true }).tap();
      await sheetClose(page).tap();
      await expect(sheetClose(page)).toHaveCount(0);

      await page.getByTestId("action-node-action-1").tap();
      await expect(sheet(page).locator("#label")).toHaveValue("HTTP Request");
      await sheetClose(page).tap();
      await expect(sheetClose(page)).toHaveCount(0);

      await page.locator(".react-flow__node-trigger").first().tap();
      await expect(sheet(page).locator("#label")).toHaveValue("Manual Trigger");
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("on a phone, a tap on the sheet as it opens presses nothing", async ({
    page,
  }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      const trigger = await box(page.locator(".react-flow__node-trigger"));
      // The second tap of a double tap, on what slid under the finger: the
      // sheet's tab bar, where Runs would otherwise open. A loaded runner can
      // deliver it late or before the sheet covers that spot, so the page
      // times it and a pair it cannot judge is tried again.
      let judged = false;
      for (let attempt = 0; attempt < 5 && !judged; attempt += 1) {
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.evaluate(trackSheetAndNextPress);
        await page.touchscreen.tap(
          trigger.x + trigger.width / 2,
          trigger.y + trigger.height / 2
        );
        await sheet(page).waitFor({ state: "attached" });
        await page.waitForTimeout(80);
        await page.touchscreen.tap(PHONE.width / 2, PHONE.height - 30);
        // Past the sheet's 400ms grace, so a late close or switch shows.
        await page.waitForTimeout(600);
        const press = await page.evaluate(
          () => ({ ...(window as unknown as SheetPress) }) as SheetPress
        );
        const gap = press.pressedAt - press.sheetOpenedAt;
        // Well inside the grace, which starts a little before the page sees it
        judged = press.pressOnSheet && gap > 0 && gap < 300;
        if (judged) {
          expect(press.pressDropped).toBe(true);
          await expect(sheet(page).locator("#label")).toHaveValue(
            "Manual Trigger"
          );
          await expect(page.getByRole("listbox")).toHaveCount(0);
        } else {
          // Escape closes anything a late tap opened, then the sheet.
          for (let key = 0; key < 3; key += 1) {
            if ((await page.getByRole("dialog").count()) === 0) {
              break;
            }
            await page.keyboard.press("Escape");
            await page.waitForTimeout(300);
          }
        }
      }
      expect(judged, "a tap on the sheet delivered inside the grace").toBe(
        true
      );
      // Later, a tap around the sheet does close it.
      await page.touchscreen.tap(BACKDROP.x, BACKDROP.y);
      await expect(sheet(page)).toBeHidden();
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("on a phone, a double tap leaves the sheet open", async ({ page }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      const trigger = await box(page.locator(".react-flow__node-trigger"));
      const point = {
        x: trigger.x + trigger.width / 2,
        y: trigger.y + trigger.height / 2,
      };
      await page.touchscreen.tap(point.x, point.y);
      await sheet(page).waitFor({ state: "attached" });
      await page.touchscreen.tap(point.x, point.y);
      await page.waitForTimeout(600);
      // The sheet stays open on the tapped step.
      await expect(sheet(page).locator("#label")).toHaveValue("Manual Trigger");
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("on a tablet, in the side panel as before", async ({ page }) => {
    const id = await openWorkflow(page, TABLET);
    try {
      await page.getByTestId("action-node-action-1").tap();
      await expect(page.locator("#label")).toHaveValue("HTTP Request");
      await expect(sheetClose(page)).toHaveCount(0);
    } finally {
      await deleteTestWorkflow(id);
    }
  });
});

test.describe("Adding a step on a phone opens its action picker", () => {
  test("from the + beside a step, centred for when the sheet closes", async ({
    page,
  }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      await page
        .getByTestId("rf__node-action-1")
        .getByRole("button", { name: "Add step", exact: true })
        .tap();
      await expect(sheet(page).getByTestId("action-grid")).toBeVisible();
      await expect(page.locator(NEW_STEP)).toHaveCount(1);
      await sheetClose(page).tap();
      await expect(sheetClose(page)).toHaveCount(0);
      await expect
        .poll(async () => {
          const step = await box(page.locator(NEW_STEP));
          return (
            step.x >= 0 &&
            step.x + step.width <= PHONE.width &&
            step.y >= 0 &&
            step.y + step.height <= PHONE.height
          );
        })
        .toBe(true);
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("from a drag off a step's handle", async ({ page }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      const handle = await box(
        page.locator(".react-flow__node-trigger .react-flow__handle.source")
      );
      const from = {
        x: handle.x + handle.width / 2,
        y: handle.y + handle.height / 2,
      };
      await touchDrag(page, from, { x: from.x, y: from.y + 220 });
      await expect(sheet(page).getByTestId("action-grid")).toBeVisible();
      await expect(page.locator(NEW_STEP)).toHaveCount(1);
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("from the canvas menu's Add Step", async ({ page }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      // Android opens the canvas menu on a long press, with the same
      // contextmenu event a right click sends.
      const canvas = await box(page.locator(".react-flow__pane"));
      await page.mouse.click(canvas.x + 40, canvas.y + 200, {
        button: "right",
      });
      const addStep = page.getByRole("button", {
        name: "Add Step",
        exact: true,
      });
      await expect(addStep).toBeVisible();
      await addStep.tap();
      await expect(sheet(page).getByTestId("action-grid")).toBeVisible();
      await expect(page.locator(NEW_STEP)).toHaveCount(1);
    } finally {
      await deleteTestWorkflow(id);
    }
  });
});
