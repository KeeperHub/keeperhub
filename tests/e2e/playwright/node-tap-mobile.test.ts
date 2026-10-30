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

type TapTimes = {
  sheetOpenedAt: number;
  secondPressAt: number;
  sheetTookPresses: string;
};

// In the page: when the sheet appears, and the first press after that with
// whether the sheet took presses at that moment.
function trackSheetAndSecondTap(): void {
  const w = window as unknown as TapTimes;
  w.sheetOpenedAt = 0;
  w.secondPressAt = 0;
  w.sheetTookPresses = "";
  new MutationObserver((_, observer) => {
    if (document.querySelector('[role="dialog"][data-state="open"]')) {
      w.sheetOpenedAt = performance.now();
      observer.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener(
    "pointerdown",
    (event) => {
      const dialog = document.querySelector(
        '[role="dialog"][data-state="open"]'
      );
      if (dialog && w.sheetOpenedAt && !w.secondPressAt) {
        w.secondPressAt = event.timeStamp;
        w.sheetTookPresses = getComputedStyle(dialog).pointerEvents;
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

  test("on a phone, a double tap leaves the sheet open", async ({ page }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      const trigger = await box(page.locator(".react-flow__node-trigger"));
      const point = {
        x: trigger.x + trigger.width / 2,
        y: trigger.y + trigger.height / 2,
      };
      // A double tap: the second tap lands on the sheet the first one opened
      // (or its backdrop), within its 400ms grace. A loaded runner can deliver
      // it later, so the page times both and a late pair is tried again.
      let judged = false;
      for (let attempt = 0; attempt < 5 && !judged; attempt += 1) {
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.evaluate(trackSheetAndSecondTap);
        await page.touchscreen.tap(point.x, point.y);
        await sheet(page).waitFor({ state: "attached" });
        await page.touchscreen.tap(point.x, point.y);
        // Past the grace, so a late close would have happened by now.
        await page.waitForTimeout(600);
        const times = await page.evaluate(
          () => ({ ...(window as unknown as TapTimes) }) as TapTimes
        );
        const gap = times.secondPressAt - times.sheetOpenedAt;
        // Well inside the grace, which starts a little before the page sees it
        judged = gap > 0 && gap < 300;
        if (judged) {
          // The settling sheet took no presses: the tap fell through to the
          // backdrop, whose grace ignored it.
          expect(times.sheetTookPresses).toBe("none");
          await expect(sheet(page).locator("#label")).toHaveValue(
            "Manual Trigger"
          );
          // Nothing the sheet slid under the finger was pressed.
          await expect(page.getByRole("listbox")).toHaveCount(0);
        } else {
          // A late second tap may have opened a select in the settled sheet:
          // Escape closes that first, then the sheet.
          for (let press = 0; press < 3; press += 1) {
            if ((await page.getByRole("dialog").count()) === 0) {
              break;
            }
            await page.keyboard.press("Escape");
            await page.waitForTimeout(300);
          }
        }
      }
      expect(judged, "a double tap delivered inside the grace").toBe(true);
      // Later, the same tap does close it.
      await page.touchscreen.tap(BACKDROP.x, BACKDROP.y);
      await expect(sheet(page)).toBeHidden();
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
