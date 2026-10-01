import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

const SELECTED_CLASS = /\bselected\b/;

async function createWorkflow(label: string): Promise<string> {
  const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
    name: `double-click-${label}-${Date.now()}`,
    triggerType: "manual",
    enabled: false,
  });
  return workflow.id;
}

async function openOnTab(
  page: Page,
  workflowId: string,
  tabName: "Runs" | "History"
): Promise<void> {
  await page.goto(`/workflows/${workflowId}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCanvas(page);
  const tab = page.getByRole("tab", { name: tabName, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

test.describe("Double-clicking a node opens its properties", () => {
  for (const tabName of ["Runs", "History"] as const) {
    test(`from the ${tabName} tab`, async ({ page }) => {
      const id = await createWorkflow(tabName.toLowerCase());
      try {
        await openOnTab(page, id, tabName);
        const tab = page.getByRole("tab", { name: tabName, exact: true });
        const actionNode = page.getByTestId("action-node-action-1");

        // Single click selects the node and keeps the current tab.
        await actionNode.click();
        await expect(page.getByTestId("rf__node-action-1")).toHaveClass(
          SELECTED_CLASS
        );
        await expect(tab).toHaveAttribute("aria-selected", "true");

        await actionNode.dblclick();
        await expect(
          page.getByRole("tab", { name: "Properties", exact: true })
        ).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("properties-panel")).toBeVisible();
        await expect(page.locator("#label")).toHaveValue("HTTP Request");
      } finally {
        await deleteTestWorkflow(id);
      }
    });
  }

  test("works for the trigger node", async ({ page }) => {
    const id = await createWorkflow("trigger");
    try {
      await openOnTab(page, id, "Runs");
      await page.locator(".react-flow__node-trigger").first().dblclick();
      await expect(
        page.getByRole("tab", { name: "Properties", exact: true })
      ).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#label")).toHaveValue("Manual Trigger");
    } finally {
      await deleteTestWorkflow(id);
    }
  });
});
