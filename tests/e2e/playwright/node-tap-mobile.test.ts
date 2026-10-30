import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { dismissPhoneOverlays } from "./utils/layout";
import { waitForCanvas } from "./utils/workflow";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

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
  return workflow.id;
}

// The phone sheet; the hidden side panel stays in the page beside it.
function sheet(page: Page): Locator {
  return page.getByRole("dialog");
}

// The Configuration sheet, found by its Close button (a drawer on phones).
function sheetClose(page: Page): Locator {
  return page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true });
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
      await expect(sheetClose(page)).toHaveCount(1);
      await expect(sheet(page).locator("#label")).toHaveValue("HTTP Request");
      await sheetClose(page).tap();
      await expect(sheetClose(page)).toHaveCount(0);

      await page.locator(".react-flow__node-trigger").first().tap();
      await expect(sheetClose(page)).toHaveCount(1);
      await expect(sheet(page).locator("#label")).toHaveValue("Manual Trigger");
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("on a phone, adding a step opens the sheet on its action picker", async ({
    page,
  }) => {
    const id = await openWorkflow(page, PHONE);
    try {
      await page
        .getByTestId("rf__node-action-1")
        .getByRole("button", { name: "Add step", exact: true })
        .tap();
      await expect(sheetClose(page)).toHaveCount(1);
      await expect(sheet(page).getByTestId("action-grid")).toBeVisible();
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
