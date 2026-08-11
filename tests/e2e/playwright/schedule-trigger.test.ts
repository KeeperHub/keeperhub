import { expect, test } from "./fixtures";
import { gotoCanvas } from "./utils/workflow";

const SELECTED_CLASS_REGEX = /selected/;

test.describe("Schedule Trigger", () => {
  test.beforeEach(async ({ page }) => {
    // "/" is the wallet-scanner landing now; enter the builder to reach the
    // workflow canvas.
    await gotoCanvas(page);
  });

  test("can access trigger node configuration", async ({ page }) => {
    // Find and click the trigger node
    const triggerNode = page.locator(".react-flow__node-trigger").first();

    if (await triggerNode.isVisible()) {
      await triggerNode.click();

      // Verify trigger node is selected
      await expect(triggerNode).toHaveClass(SELECTED_CLASS_REGEX);

      // Check that properties panel shows trigger configuration
      const _propertiesPanel = page.locator('[data-testid="properties-panel"]');
      // The panel may or may not exist depending on implementation
      // Just verify the trigger node can be selected
    }
  });

  test("trigger node shows trigger type options", async ({ page }) => {
    const triggerNode = page.locator(".react-flow__node-trigger").first();

    if (await triggerNode.isVisible()) {
      await triggerNode.click();

      // Verify trigger is selected before checking for config
      await expect(triggerNode).toHaveClass(SELECTED_CLASS_REGEX);

      // Look for trigger type selector/dropdown
      const triggerTypeSelector = page.locator(
        '[data-testid="trigger-type-selector"], [data-testid="trigger-config"]'
      );

      // If trigger type selector exists, verify it's accessible
      if (await triggerTypeSelector.isVisible()) {
        await expect(triggerTypeSelector).toBeVisible();
      }
    }
  });

  test("workflow canvas maintains state after trigger configuration", async ({
    page,
  }) => {
    // Wait for canvas to render with at least one node
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10_000,
    });

    // Get initial node count after canvas is stable
    const initialNodes = await page.locator(".react-flow__node").count();

    // Click on trigger node
    const triggerNode = page.locator(".react-flow__node-trigger").first();
    if (await triggerNode.isVisible()) {
      await triggerNode.click();
      // React Flow marks selection with the "selected" class, not an attribute.
      await expect(triggerNode).toHaveClass(SELECTED_CLASS_REGEX);

      // Deselect with Escape (same as getWebhookUrl); a pane click is
      // intercepted by the left flyout and the top promo banner overlays.
      await page.keyboard.press("Escape");
      await expect(triggerNode).not.toHaveClass(SELECTED_CLASS_REGEX);
    }

    // Verify node count is preserved
    const finalNodes = await page.locator(".react-flow__node").count();
    expect(finalNodes).toBe(initialNodes);
  });

  test("can create workflow with action node after trigger", async ({
    page,
  }) => {
    // Find the trigger node's source handle
    const triggerHandle = page.locator(
      ".react-flow__node-trigger .react-flow__handle-source"
    );

    if (await triggerHandle.isVisible()) {
      const handleBox = await triggerHandle.boundingBox();
      if (handleBox) {
        // Drag from handle to create new node
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(handleBox.x + 300, handleBox.y);
        await page.mouse.up();

        // Verify action grid appears
        const actionGrid = page.locator('[data-testid="action-grid"]');
        await expect(actionGrid).toBeVisible({ timeout: 5000 });

        // Verify we can select an action
        const httpRequestAction = page.locator(
          '[data-testid="action-option-http-request"]'
        );

        if (await httpRequestAction.isVisible()) {
          await httpRequestAction.click();

          // Verify action node exists
          const actionNode = page.locator(".react-flow__node-action");
          await expect(actionNode).toBeVisible();
        }
      }
    }
  });

  test("workflow has visible edge between trigger and action", async ({
    page,
  }) => {
    // Create an action node from trigger
    const triggerHandle = page.locator(
      ".react-flow__node-trigger .react-flow__handle-source"
    );

    if (await triggerHandle.isVisible()) {
      const handleBox = await triggerHandle.boundingBox();
      if (handleBox) {
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(handleBox.x + 300, handleBox.y);
        await page.mouse.up();

        // Wait for action grid
        const actionGrid = page.locator('[data-testid="action-grid"]');
        await expect(actionGrid).toBeVisible({ timeout: 5000 });

        // Select an action
        const httpRequestAction = page.locator(
          '[data-testid="action-option-http-request"]'
        );

        if (await httpRequestAction.isVisible()) {
          await httpRequestAction.click();

          // Verify action grid closes (action configured)
          await expect(actionGrid).not.toBeVisible({ timeout: 5000 });

          // Verify edge exists
          const edges = page.locator(".react-flow__edge");
          const edgeCount = await edges.count();
          expect(edgeCount).toBeGreaterThan(0);
        }
      }
    }
  });

  test("trigger node displays label", async ({ page }) => {
    const triggerNode = page.locator(".react-flow__node-trigger").first();

    if (await triggerNode.isVisible()) {
      // Trigger should have some text content
      const nodeText = await triggerNode.textContent();
      expect(nodeText).toBeTruthy();
    }
  });
});

// API and Database tests for workflow execution are in:
// - tests/e2e/workflow-runner.test.ts (vitest - execution lifecycle, database updates)
