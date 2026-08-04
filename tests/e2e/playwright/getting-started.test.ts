import { expect, test } from "./fixtures";

// The first-run "Get started" launcher. Signed in as the persistent test user
// (default storageState). The launcher is a bottom-left pill; for a first-time
// user (no persisted state) it auto-expands into a single-branch (agent)
// checklist and persists its state per user.

// The rest of the suite suppresses the first-run auto-expand (see fixtures.ts)
// so the card never covers the canvas; this file exercises it, so opt back in.
test.use({ disableGettingStarted: false });

// Clear any persisted launcher state so each test starts from the default
// (a fresh, never-seen user), regardless of what a prior run left behind.
async function resetLauncher(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("kh:getting-started:")) {
        localStorage.removeItem(key);
      }
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

test.describe("getting-started launcher", () => {
  test.beforeEach(async ({ page }) => {
    await resetLauncher(page);
  });

  test("auto-expands into the agent checklist for a first-time user", async ({
    page,
  }) => {
    // No persisted state means the launcher opens expanded by default.
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });

    // The single agent branch's steps are shown (no branch tabs).
    await expect(page.getByTestId("gs-step-wallet-ready")).toBeVisible();
    await expect(page.getByTestId("gs-step-connect-agent")).toBeVisible();
    await expect(page.getByTestId("gs-step-run-workflow")).toBeVisible();
  });

  test("the pill collapses and re-expands the card", async ({ page }) => {
    const pill = page.getByTestId("gs-launcher-pill");
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });

    await pill.click();
    await expect(page.getByTestId("gs-launcher-card")).toBeHidden();

    await pill.click();
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible();
  });

  test("a step completes when its action is taken", async ({ page }) => {
    // Completion is click-driven: taking the step's action marks it done.
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });
    const walletStep = page.getByTestId("gs-step-wallet-ready");
    await expect(walletStep).toHaveAttribute("data-complete", "false");

    // The first button in the row is the step action (the second is "more info").
    await walletStep.getByRole("button").first().click();
    await expect(walletStep).toHaveAttribute("data-complete", "true", {
      timeout: 10_000,
    });
  });

  test("dismiss hides the launcher and persists across reload", async ({
    page,
  }) => {
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByTestId("gs-launcher-card")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();

    await expect(page.getByTestId("gs-launcher-card")).toBeHidden();
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden({
      timeout: 5000,
    });
  });

  test("reopens from the user menu after dismissal", async ({ page }) => {
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByTestId("gs-launcher-card")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(page.getByTestId("gs-launcher-pill")).toBeHidden();

    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Getting started" }).click();

    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 10_000,
    });
  });
});
