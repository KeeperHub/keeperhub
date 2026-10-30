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
  await expect(page.getByTitle("Configuration", { exact: true })).toBeVisible();
  return workflow.id;
}

// Scoped to the sheet: the hidden side panel has its own #label and picker.
function sheet(page: Page): Locator {
  return page.getByRole("dialog", { name: "Step settings" });
}

// The Configuration sheet, found by its Close button (a drawer on phones).
function sheetClose(page: Page): Locator {
  return page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true });
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
      await page.touchscreen.tap(point.x, point.y);
      await expect(sheet(page)).toBeVisible();
      // The trigger's sheet is short, so the second tap lands on the backdrop.
      expect((await box(sheet(page))).y).toBeGreaterThan(point.y);
      await page.touchscreen.tap(point.x, point.y);
      await page.waitForTimeout(600);
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
  test("from the + beside a step, with the new step in view", async ({
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
      await expect
        .poll(async () => {
          const step = await box(page.locator(NEW_STEP));
          return step.x >= 0 && step.x + step.width <= PHONE.width;
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
