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

        // Selecting a node must not reload the workflow: a reload replaces the
        // canvas nodes and drops the selection the double-click relies on.
        const workflowReloads: string[] = [];
        page.on("request", (request) => {
          const { pathname } = new URL(request.url());
          if (
            request.method() === "GET" &&
            pathname === `/api/workflows/${id}`
          ) {
            workflowReloads.push(request.url());
          }
        });

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
        expect(workflowReloads).toEqual([]);
      } finally {
        await deleteTestWorkflow(id);
      }
    });
  }

  test("keeps the Runs panel mounted while selecting nodes", async ({
    page,
  }) => {
    const id = await createWorkflow("runs-kept");
    try {
      await openOnTab(page, id, "Runs");
      // Tag the panel's DOM: a remount (which would drop an expanded run or
      // the loaded pages) replaces the element and loses the tag.
      const runsContent = page
        .locator('[role="tabpanel"][data-state="active"] > *')
        .first();
      await runsContent.evaluate((element) =>
        element.setAttribute("data-e2e-kept", "1")
      );

      await page.getByTestId("action-node-action-1").click();
      await expect(page.getByTestId("properties-panel")).toBeVisible();
      await expect(runsContent).toHaveAttribute("data-e2e-kept", "1");

      // Click empty canvas below the nodes to deselect.
      const canvas = await page.getByTestId("workflow-canvas").boundingBox();
      if (!canvas) {
        throw new Error("workflow canvas has no bounding box");
      }
      await page.mouse.click(
        canvas.x + canvas.width / 2,
        canvas.y + canvas.height - 80
      );
      await expect(page.getByTestId("properties-panel")).toBeHidden();
      await expect(runsContent).toHaveAttribute("data-e2e-kept", "1");
    } finally {
      await deleteTestWorkflow(id);
    }
  });

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
