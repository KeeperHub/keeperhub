import { join } from "node:path";
import { expect, test } from "./fixtures";
import { createWorkflow } from "./utils/workflow";

const VALID_FIXTURE_PATH = join(
  process.cwd(),
  "tests/unit/fixtures/workflow-import-valid.json"
);

// The DownloadButton in components/workflow/workflow-toolbar.tsx is icon-only and
// uses `title="Export workflow as JSON"` as its accessible name. Match that title
// text rather than visible "Download" copy.
const DOWNLOAD_BUTTON_NAME_REGEX = /export workflow as json/i;
const SELECTED_TEXT_REGEX = /Selected:/i;
const IMPORT_BUTTON_NAME_REGEX = /import workflow/i;
const WORKFLOW_URL_REGEX = /\/workflows?\/[^/]+/;
const IMPORT_ENDPOINT = "/api/workflows/import";

// MODAL-06 imports a fixture containing an HTTP Request action, which is
// Pro-gated (lib/features/registry.ts) and otherwise blocked at import for a
// free org. Run as the seeded pro-plan user.
test.use({ storageState: "tests/e2e/playwright/.auth/pro.json" });

test.describe("Workflow I/O modal (MODAL-04, MODAL-05, MODAL-06, MODAL-08)", () => {
  test.beforeEach(async ({ page }) => {
    // The Playwright `chromium` project loads the persistent test user's
    // storageState (tests/e2e/playwright/.auth/user.json) via auth.setup.ts,
    // so the page starts authenticated. Just create a workflow so the toolbar
    // Download button is enabled (it gates on currentWorkflowId).
    await createWorkflow(page);
  });

  test("Download button opens the unified WorkflowIOOverlay (MODAL-04)", async ({
    page,
  }) => {
    const downloadButton = page
      .getByRole("button", { name: DOWNLOAD_BUTTON_NAME_REGEX })
      .first();
    await expect(downloadButton).toBeVisible({ timeout: 10_000 });
    await downloadButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });
    // The unified overlay's literal DialogTitle text from plan 42-07.
    await expect(
      dialog.getByText("Workflow Import / Export", { exact: true })
    ).toBeVisible();

    // BOTH sections must be rendered together (no Tabs, MODAL-08).
    await expect(
      dialog.getByRole("heading", { level: 3, name: "Import" })
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { level: 3, name: "Export" })
    ).toBeVisible();

    // Tabs DOM must NOT be present — Radix Tabs use [role="tab"].
    expect(await dialog.locator('[role="tab"]').count()).toBe(0);
    expect(await dialog.locator('[role="tablist"]').count()).toBe(0);
  });

  test("Closing the modal resets file state (MODAL-05/MODAL-07)", async ({
    page,
  }) => {
    const downloadButton = page
      .getByRole("button", { name: DOWNLOAD_BUTTON_NAME_REGEX })
      .first();
    await downloadButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Attach the valid fixture
    const fileInput = dialog.locator('input[type="file"]').first();
    await fileInput.setInputFiles(VALID_FIXTURE_PATH);
    await expect(dialog.getByText(SELECTED_TEXT_REGEX)).toBeVisible({
      timeout: 5000,
    });

    // Close via Escape
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5000 });

    // Reopen
    await downloadButton.click();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    // File state must be cleared — the "Selected:" indicator must not appear.
    expect(await dialog.getByText(SELECTED_TEXT_REGEX).count()).toBe(0);
    // The file input itself should be empty.
    const reopenedFileInput = dialog.locator('input[type="file"]').first();
    const fileValue = await reopenedFileInput.inputValue();
    expect(fileValue).toBe("");
  });

  test("Successful import follows the toast > close > navigate ordering (MODAL-06)", async ({
    page,
  }) => {
    const downloadButton = page
      .getByRole("button", { name: DOWNLOAD_BUTTON_NAME_REGEX })
      .first();
    await downloadButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const fileInput = dialog.locator('input[type="file"]').first();
    await fileInput.setInputFiles(VALID_FIXTURE_PATH);

    const importButton = dialog.getByRole("button", {
      name: IMPORT_BUTTON_NAME_REGEX,
    });
    await expect(importButton).toBeEnabled({ timeout: 10_000 });

    // Wait on the import request itself rather than guessing how long a cold
    // route takes under CI load, so a slow import does not read as a missing toast.
    const importResponse = page.waitForResponse(
      (response) =>
        response.url().includes(IMPORT_ENDPOINT) &&
        response.request().method() === "POST",
      { timeout: 60_000 }
    );
    await importButton.click();
    expect((await importResponse).ok()).toBe(true);

    // The component contract (plan 42-07) is: toast.success -> onOpenChange(false)
    // -> router.push. We assert all three end states are reached.
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      "Workflow imported",
      { timeout: 15_000 }
    );
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await page.waitForURL(WORKFLOW_URL_REGEX, { timeout: 15_000 });
  });

  test("Old import-workflow-overlay and export-workflow-overlay components do not render (MODAL-01/MODAL-08)", async ({
    page,
  }) => {
    const downloadButton = page
      .getByRole("button", { name: DOWNLOAD_BUTTON_NAME_REGEX })
      .first();
    await downloadButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Neither old test-id should appear anywhere in the DOM.
    expect(
      await page.locator('[data-testid="import-workflow-overlay"]').count()
    ).toBe(0);
    expect(
      await page.locator('[data-testid="export-workflow-overlay"]').count()
    ).toBe(0);
  });
});
