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

type SheetPage = {
  pressDropped: boolean | null;
  firstLabel: Element | null;
};

// In the page: as the sheet appears, still settling, a press and click on
// its Runs tab, the second tap of a double tap on what slid under the finger.
function pressRunsWhileSettling(): void {
  const w = window as unknown as SheetPage;
  w.pressDropped = null;
  new MutationObserver((_, observer) => {
    const settling = document.querySelector('[role="dialog"][data-settling]');
    const runs = Array.from(settling?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Runs"
    );
    if (!runs) {
      return;
    }
    observer.disconnect();
    const rect = runs.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    const touch = { ...at, pointerType: "touch", isPrimary: true };
    const press = new PointerEvent("pointerdown", touch);
    runs.dispatchEvent(press);
    w.pressDropped = press.defaultPrevented;
    runs.dispatchEvent(new PointerEvent("pointerup", touch));
    runs.dispatchEvent(new MouseEvent("click", { ...at, detail: 1 }));
  }).observe(document.body, {
    attributeFilter: ["data-settling"],
    childList: true,
    subtree: true,
  });
}

// In the page: the sheet's first Label field, to tell a remount apart.
function keepFirstSheetLabel(): void {
  const w = window as unknown as SheetPage;
  w.firstLabel = null;
  new MutationObserver((_, observer) => {
    w.firstLabel = document.querySelector('[role="dialog"] #label');
    if (w.firstLabel) {
      observer.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
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
      await page.evaluate(pressRunsWhileSettling);
      await page.locator(".react-flow__node-trigger").first().tap();
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as SheetPage).pressDropped)
        )
        .toBe(true);
      // Once settled, a Runs press that got through would have shown.
      await expect(sheet(page)).not.toHaveAttribute("data-settling");
      await expect(sheet(page).locator("#label")).toHaveValue("Manual Trigger");
      // Later, a tap around the sheet does close it.
      await page.touchscreen.tap(BACKDROP.x, BACKDROP.y);
      await expect(sheet(page)).toBeHidden();
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("on a phone, a double tap opens the sheet once and leaves it open", async ({
    page,
  }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      const step = page.locator(".react-flow__node-trigger");
      const trigger = await box(step);
      const point = {
        x: trigger.x + trigger.width / 2,
        y: trigger.y + trigger.height / 2,
      };
      await page.evaluate(keepFirstSheetLabel);
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
      await expect(sheet(page)).toBeVisible();
      // On a slow phone the second tap reaches the step before the sheet
      // covers it, and the step sees a click and a double click.
      await step.dispatchEvent("click");
      await step.dispatchEvent("dblclick");
      // Past the grace, so a late close would have happened by now.
      await expect(sheet(page)).not.toHaveAttribute("data-settling");
      await expect(sheet(page).locator("#label")).toHaveValue("Manual Trigger");
      // Not reopened by the second tap: the same Label field as at first.
      expect(
        await page.evaluate(() => {
          const w = window as unknown as SheetPage;
          return (
            w.firstLabel !== null &&
            w.firstLabel === document.querySelector('[role="dialog"] #label')
          );
        })
      ).toBe(true);
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
