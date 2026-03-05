import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// Top-level regex patterns
const WORKFLOW_ID_REGEX = /\/workflows?\/([a-zA-Z0-9_-]+)/;
const SAVE_WORKFLOW_REGEX = /Save workflow/i;
const WEBHOOK_OPTION_REGEX = /webhook/i;

/**
 * Wait for workflow canvas to be ready.
 */
export async function waitForCanvas(page: Page): Promise<void> {
  await page.waitForSelector(
    '[data-testid="workflow-canvas"][data-ready="true"]',
    {
      state: "visible",
      timeout: 60_000,
    }
  );
}

/**
 * Create a new workflow by navigating to the homepage canvas.
 * The app uses an embedded canvas at `/` for new workflows.
 * For authenticated users, may need to click "Start building" to initialize.
 * Returns "new" as placeholder - actual ID is assigned after save.
 */
export async function createWorkflow(
  page: Page,
  _name?: string
): Promise<string> {
  // Navigate to homepage which has the workflow canvas
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Wait for canvas to load
  await waitForCanvas(page);

  // Check for trigger node first (might already be in edit mode)
  const triggerNode = page.locator(".react-flow__node-trigger").first();

  // If trigger already visible, we're in edit mode
  if (await triggerNode.isVisible({ timeout: 2000 }).catch(() => false)) {
    // Already in edit mode, continue
  } else {
    // Need to click "Start building" to enter edit mode
    const startButton = page.getByRole("button", { name: "Start building" });
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await startButton.click({ force: true });
    // Wait for trigger node to appear after clicking
    await expect(triggerNode).toBeVisible({ timeout: 20_000 });
  }

  // Click on trigger node to ensure we're in edit mode and toolbar appears
  await triggerNode.click();

  // Wait for the toolbar "Add Step" button to appear (indicates full editor mode)
  // The button might have different names/icons, look for the plus icon button too
  const addStepButton = page
    .getByRole("button", { name: "Add Step" })
    .or(page.locator('[data-testid="add-step-button"]'));
  await expect(addStepButton.first()).toBeVisible({ timeout: 10_000 });

  // Check if URL has a workflow ID (saved workflow)
  const url = page.url();
  const match = url.match(WORKFLOW_ID_REGEX);

  // If on homepage without ID, this is a new unsaved workflow
  // Return "new" as placeholder - actual ID is assigned after save
  return match ? match[1] : "new";
}

/**
 * Open an existing workflow by ID.
 */
export async function openWorkflow(
  page: Page,
  workflowId: string
): Promise<void> {
  await page.goto(`/workflow/${workflowId}`, { waitUntil: "domcontentloaded" });
  await waitForCanvas(page);
}

/**
 * Add an action node to the workflow canvas.
 * Uses the "Add Step" button in toolbar, which creates a node and opens the action grid in config panel.
 */
export async function addActionNode(
  page: Page,
  actionLabel: string
): Promise<void> {
  // Wait for any compilation to finish
  const compilingIndicator = page.locator('text="Compiling"');
  if (
    await compilingIndicator.isVisible({ timeout: 1000 }).catch(() => false)
  ) {
    await expect(compilingIndicator).not.toBeVisible({ timeout: 30_000 });
  }

  const actionGrid = page.locator('[data-testid="action-grid"]');

  // Check if action grid is already visible
  if (!(await actionGrid.isVisible({ timeout: 500 }).catch(() => false))) {
    // Try clicking an existing unconfigured action node first
    const unconfiguredAction = page.locator(
      '.react-flow__node-action:has-text("Select an action")'
    );
    if (
      await unconfiguredAction.isVisible({ timeout: 1000 }).catch(() => false)
    ) {
      await unconfiguredAction.click();
    } else {
      // Use the "Add Step" button in toolbar - creates node and selects it
      const addStepButton = page.getByRole("button", { name: "Add Step" });
      await expect(addStepButton).toBeVisible({ timeout: 5000 });
      await addStepButton.click();

      // Wait for the new action node to appear on canvas
      const newActionNode = page.locator(".react-flow__node-action");
      await expect(newActionNode).toBeVisible({ timeout: 5000 });
    }
  }

  // Wait for action grid to appear in config panel (right side)
  await expect(actionGrid).toBeVisible({ timeout: 10_000 });

  // Search for the action using the search input
  const searchInput = page.locator('[data-testid="action-search-input"]');
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  await searchInput.fill(actionLabel);

  // Convert label to data-testid format (e.g., "Send Webhook" -> "send-webhook")
  const actionSlug = actionLabel.toLowerCase().replace(/\s+/g, "-");

  // Click the action option
  const actionOption = page
    .locator(`[data-testid="action-option-${actionSlug}"]`)
    .or(page.getByText(actionLabel, { exact: true }))
    .first();

  await expect(actionOption).toBeVisible({ timeout: 10_000 });
  await actionOption.click();

  // Wait for action to be configured (grid should close, action label should appear)
  await expect(actionGrid).not.toBeVisible({ timeout: 5000 });
}

/**
 * Configure an action node with the given values.
 * Expects the action node to be selected.
 * Handles both text inputs and Radix UI comboboxes/selects.
 */
export async function configureAction(
  page: Page,
  config: Record<string, string>
): Promise<void> {
  for (const [fieldName, value] of Object.entries(config)) {
    const input = page.locator(
      `[data-testid="config-${fieldName}"], #${fieldName}`
    );
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Check if this is a combobox (Radix UI Select) or a regular input
      const role = await input.getAttribute("role");
      const tagName = await input.evaluate((el) => el.tagName.toLowerCase());

      if (role === "combobox" || tagName === "button") {
        // Radix UI Select - click to open dropdown and select option
        await input.click();
        const option = page.getByRole("option", {
          name: new RegExp(value, "i"),
        });
        await expect(option).toBeVisible({ timeout: 3000 });
        await option.click();
      } else {
        // Regular text input
        await input.fill(value);
      }
    }
  }
}

/**
 * Save the current workflow.
 */
export async function saveWorkflow(page: Page): Promise<void> {
  // The save button may be icon-only with accessible name "Save workflow"
  const saveButton = page.getByRole("button", { name: SAVE_WORKFLOW_REGEX });
  await expect(saveButton).toBeVisible({ timeout: 5000 });
  await saveButton.click();

  // Wait for save to complete - look for toast or URL change
  // Don't use networkidle as it hangs when there's polling
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast)
    .toBeVisible({ timeout: 10_000 })
    .catch(() => {
      // Toast may not appear, that's OK
    });

  // Wait for post-save redirect (new workflows get assigned an ID in the URL)
  await page.waitForURL(/workflow/, { timeout: 10_000 }).catch(() => {
    // URL may already contain workflow ID, that's OK
  });
}

/**
 * Trigger a workflow manually via the UI.
 */
export async function triggerWorkflowManually(page: Page): Promise<void> {
  // Use specific selector to avoid matching "Runs" tab
  const triggerButton = page
    .getByRole("button", { name: "Run", exact: true })
    .or(page.getByRole("button", { name: "Run Workflow" }))
    .or(page.locator('[data-testid="run-workflow"]'))
    .first();
  await expect(triggerButton).toBeVisible({ timeout: 5000 });
  await triggerButton.click();

  // Toast is optional - some workflows may not show it
  const toast = page.locator("[data-sonner-toast]").first();
  await toast.isVisible({ timeout: 5000 }).catch(() => false);
}

/**
 * Configure the trigger node with schedule settings.
 */
export async function configureScheduleTrigger(
  page: Page,
  cronExpression: string
): Promise<void> {
  // Click on trigger node to select it
  const triggerNode = page.locator(".react-flow__node-trigger").first();
  await expect(triggerNode).toBeVisible({ timeout: 5000 });
  await triggerNode.click();

  // Find and fill cron expression input
  const cronInput = page.locator(
    '[data-testid="cron-input"], #cron-expression'
  );
  if (await cronInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await cronInput.fill(cronExpression);
  }

  // Enable schedule if toggle exists
  const scheduleToggle = page.locator('[data-testid="schedule-toggle"]');
  if (await scheduleToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
    const isChecked = await scheduleToggle.isChecked();
    if (!isChecked) {
      await scheduleToggle.click();
    }
  }
}

/**
 * Configure the trigger node as webhook trigger type.
 */
export async function configureWebhookTrigger(page: Page): Promise<void> {
  // Click on trigger node to select it
  const triggerNode = page.locator(".react-flow__node-trigger").first();
  await expect(triggerNode).toBeVisible({ timeout: 5000 });
  await triggerNode.click();

  // Find and click trigger type selector
  const triggerTypeSelect = page.locator("#triggerType");
  await expect(triggerTypeSelect).toBeVisible({ timeout: 5000 });
  await triggerTypeSelect.click();

  // Select Webhook option
  const webhookOption = page.getByRole("option", {
    name: WEBHOOK_OPTION_REGEX,
  });
  await expect(webhookOption).toBeVisible({ timeout: 3000 });
  await webhookOption.click();

  // Wait for webhook config to appear
  const webhookUrlField = page.locator("text=Webhook URL");
  await expect(webhookUrlField).toBeVisible({ timeout: 5000 });
}

/**
 * Get the webhook URL for the current workflow.
 * Requires the trigger to be configured as webhook type.
 */
export async function getWebhookUrl(page: Page): Promise<string> {
  // Press Escape to deselect any selected nodes
  await page.keyboard.press("Escape");

  // Now click on trigger node - use force to avoid interception by overlapping nodes
  const triggerNode = page.locator(".react-flow__node-trigger").first();
  await expect(triggerNode).toBeVisible({ timeout: 5000 });
  await triggerNode.click({ force: true });

  // Find the webhook URL input near the "Webhook URL" label
  const webhookSection = page
    .locator("text=Webhook URL")
    .locator("..")
    .locator("input[disabled]");

  // Try the section-based approach first
  if (await webhookSection.isVisible({ timeout: 3000 }).catch(() => false)) {
    const url = await webhookSection.inputValue();
    if (url) {
      return url.trim();
    }
  }

  // Try getting all disabled inputs and find one with the webhook URL pattern
  const allDisabledInputs = page.locator("input[disabled]");
  const count = await allDisabledInputs.count();
  for (let i = 0; i < count; i++) {
    const input = allDisabledInputs.nth(i);
    const value = await input.inputValue().catch(() => "");
    if (value.includes("/api/workflows") && value.includes("/webhook")) {
      return value.trim();
    }
  }

  // Webhook URL might not be visible if trigger isn't configured as webhook type
  throw new Error(
    "Webhook URL not found - ensure trigger is configured as webhook type and workflow is saved"
  );
}

/**
 * Copy webhook URL to clipboard and return it.
 */
export async function copyWebhookUrl(page: Page): Promise<string> {
  const copyButton = page.locator('[data-testid="copy-webhook-url"]');
  await expect(copyButton).toBeVisible({ timeout: 5000 });
  await copyButton.click();

  // Get URL from clipboard
  const url = await page.evaluate(async () => navigator.clipboard.readText());

  return url;
}
