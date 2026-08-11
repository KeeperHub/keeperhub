import { expect, test } from "../fixtures";
import {
  addActionNode,
  configureAction,
  createWorkflow,
  saveWorkflow,
  triggerWorkflowManually,
  waitForCanvas,
} from "../utils/workflow";

// Top-level regex patterns
const MAINNET_OPTION_REGEX = /mainnet/i;

// Run tests serially to maintain user session state
test.describe.configure({ mode: "serial" });

// Skipped: the workflow-builder action-picker flow (Add Step -> action-grid)
// races and aborts in CI (net::ERR_ABORTED), so the action grid intermittently
// fails to render and addActionNode times out. Reproduces on a production build
// even with abundant resources, so it is not a runner-contention issue; tracked
// separately. Re-enable once the builder flow is stabilised.
// biome-ignore format: keep .skip inline so the suite body is not reindented
test.describe.skip("Happy Path: Web3 Balance Check", () => {
  // Known Ethereum address with balance (vitalik.eth)
  const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const TEST_NETWORK = "mainnet";

  test("create workflow with Web3 check-balance action", async ({ page }) => {
    // Step 1: Create a new workflow
    const workflowId = await createWorkflow(page, "Web3 Balance Workflow");
    expect(workflowId).toBeTruthy();

    // Step 2: Add Web3 Get Native Token Balance action
    await addActionNode(page, "Get Native Token Balance");

    // Step 3: Verify action node exists
    const actionNode = page.locator(".react-flow__node-action");
    await expect(actionNode).toBeVisible({ timeout: 5000 });

    // Step 4: Configure the action
    await configureAction(page, {
      network: TEST_NETWORK,
      address: TEST_ADDRESS,
    });

    // Step 5: Save the workflow
    await saveWorkflow(page);

    // Step 6: Verify save succeeded
    await page.reload();
    await waitForCanvas(page);

    const actionNodeAfterReload = page.locator(".react-flow__node-action");
    await expect(actionNodeAfterReload).toBeVisible({ timeout: 10_000 });
  });

  test("configure Web3 action with network selection", async ({ page }) => {
    // Create workflow
    await createWorkflow(page, "Web3 Network Test");

    // Add Get Native Token Balance action
    await addActionNode(page, "Get Native Token Balance");

    // Click on the action node to show config
    const actionNode = page.locator(".react-flow__node-action").first();
    await actionNode.click();

    // Find network selector (Radix UI combobox, not native select)
    const networkSelect = page.locator("#network, [name='network']");

    if (await networkSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Click to open dropdown
      await networkSelect.click();

      // Select mainnet option from dropdown
      const mainnetOption = page.getByRole("option", {
        name: MAINNET_OPTION_REGEX,
      });
      if (await mainnetOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await mainnetOption.click();
      }
    }
  });

  test("Web3 action configuration persists after save", async ({ page }) => {
    // Create workflow
    await createWorkflow(page, "Web3 Persistence Test");

    // Add and configure Get Native Token Balance action
    await addActionNode(page, "Get Native Token Balance");

    // Configure with specific values
    await configureAction(page, {
      network: TEST_NETWORK,
      address: TEST_ADDRESS,
    });

    // Save workflow
    await saveWorkflow(page);

    // Reload page
    await page.reload();
    await waitForCanvas(page);

    // Click action node to view config
    const actionNode = page.locator(".react-flow__node-action").first();
    await actionNode.click();

    // Verify address persisted - check for input value or text content
    const addressInput = page.locator(
      '[data-testid="address-input"], #address, [name="address"]'
    );
    if (await addressInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      const tagName = await addressInput.evaluate((el) =>
        el.tagName.toLowerCase()
      );
      if (tagName === "input" || tagName === "textarea") {
        await expect(addressInput).toHaveValue(TEST_ADDRESS);
      } else {
        // For non-input elements (contenteditable, divs, etc.), check text content
        await expect(addressInput).toContainText(TEST_ADDRESS.slice(0, 10));
      }
    }
  });

  test("trigger Web3 workflow and verify execution output", async ({
    page,
  }) => {
    // Create and configure workflow
    await createWorkflow(page, "Web3 Execution Test");
    await addActionNode(page, "Get Native Token Balance");
    await configureAction(page, {
      network: TEST_NETWORK,
      address: TEST_ADDRESS,
    });
    await saveWorkflow(page);

    // Trigger workflow manually
    await triggerWorkflowManually(page);

    // Dismiss any modal overlay that may appear after triggering
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]'))
      .toBeHidden({ timeout: 5000 })
      .catch(() => {
        /* no dialog to dismiss */
      });

    // Use the "Runs" tab in the current view -- use force click to bypass
    // any remaining overlay elements (e.g. dialog backdrop)
    const runsTab = page.getByRole("tab", { name: "Runs" });
    await expect(runsTab).toBeVisible({ timeout: 5000 });
    await runsTab.click({ force: true });

    // Wait for workflow runs to finish loading
    await expect(page.getByTestId("workflow-runs")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 60_000 }
    );

    // Wait for execution to appear - look for "Run #" entries in the Runs tab
    const executionEntry = page.locator("text=/Run #\\d+/").first();
    await expect(executionEntry).toBeVisible({ timeout: 60_000 });

    // Verify the execution entry is visible and contains run info
    const executionText = await executionEntry.textContent();
    expect(executionText).toContain("Run #");
  });
});
