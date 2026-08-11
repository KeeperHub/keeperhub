import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
  type WorkflowTriggerType,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

const ENABLE_BUTTON_REGEX = /^(Enable|Disable) workflow$/;

async function loadWorkflowWithTrigger(
  page: import("@playwright/test").Page,
  triggerType: WorkflowTriggerType
): Promise<string> {
  const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
    name: `enable-toggle-${triggerType}-${Date.now()}`,
    triggerType,
    enabled: false,
  });
  await page.goto(`/workflows/${workflow.id}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCanvas(page);
  return workflow.id;
}

test.describe("Workflow enable/disable toggle visibility by trigger type", () => {
  test("toggle is visible for Webhook trigger", async ({ page }) => {
    const id = await loadWorkflowWithTrigger(page, "webhook");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 10_000,
    });
    await deleteTestWorkflow(id);
  });

  test("toggle is visible for Schedule trigger", async ({ page }) => {
    const id = await loadWorkflowWithTrigger(page, "schedule");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toBeVisible({
      timeout: 10_000,
    });
    await deleteTestWorkflow(id);
  });

  test("toggle is hidden for Manual trigger", async ({ page }) => {
    const id = await loadWorkflowWithTrigger(page, "manual");
    await expect(page.getByTitle(ENABLE_BUTTON_REGEX)).toHaveCount(0);
    await deleteTestWorkflow(id);
  });
});
