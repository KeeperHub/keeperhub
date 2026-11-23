import { expect, test } from "./fixtures";
import { deleteTestWorkflow } from "./utils/db";
import { dismissPhoneOverlays } from "./utils/layout";

// The first-run "Getting started" launcher. Signed in as the persistent test
// user (default storageState). The launcher is a bottom-left pill; for a
// first-time user (no persisted state) it auto-expands into a single-branch
// (agent) checklist and persists its state per user.

// The rest of the suite suppresses the first-run auto-expand (see fixtures.ts)
// so the card never covers the canvas; this file exercises it, so opt back in.
test.use({ disableGettingStarted: false });

const STORAGE_PREFIX = "kh:getting-started:";
const WORKFLOW_URL_REGEX = /\/workflows\/[^/]+$/;
// The step buttons (the info buttons are "More info about ...").
const WALLET_STEP_REGEX = /^Wallet ready/;
const RUN_STEP_REGEX = /^Run your first workflow/;

// Clear any persisted launcher state so each test starts from the default
// (a fresh, never-seen user), regardless of what a prior run left behind.
async function resetLauncher(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((prefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    }
  }, STORAGE_PREFIX);
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

// Saves launcher state for the signed-in user (the hook's storageKey).
async function seedLauncher(
  page: import("@playwright/test").Page,
  persisted: { state: string; done?: string[] }
): Promise<void> {
  await page.evaluate(
    async ({ prefix, value }) => {
      const res = await fetch("/api/auth/get-session");
      const { user } = (await res.json()) as { user: { id: string } };
      localStorage.setItem(`${prefix}v2:${user.id}`, JSON.stringify(value));
    },
    { prefix: STORAGE_PREFIX, value: persisted }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

// Holds the new workflow's response until `release`, so the test can act while
// the request is in flight.
async function holdWorkflowCreate(
  page: import("@playwright/test").Page
): Promise<{
  release: () => Promise<void>;
  createdId: () => string;
}> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let createdId = "";
  await page.route("**/api/workflows/create", async (route) => {
    const response = await route.fetch();
    createdId = ((await response.json()) as { id: string }).id;
    await held;
    await route.fulfill({ response });
  });
  return {
    release: async () => {
      const responded = page.waitForResponse("**/api/workflows/create");
      release();
      await responded;
      // Nothing should happen next; a fixed wait gives it the chance to.
      await page.waitForTimeout(1000);
    },
    createdId: () => createdId,
  };
}

async function openFromUserMenu(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.locator('[data-testid="user-menu"]:visible').click();
  await page.getByRole("menuitem", { name: "Getting started" }).click();
}

// Without the sidebar (below 768px, and on the settings pages) the user-menu
// entry opens the checklist in an overlay instead of the sidebar card.
test.describe("getting-started without the sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await dismissPhoneOverlays(page);
  });

  test("opens in an overlay on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetLauncher(page);
    await openFromUserMenu(page);

    const overlay = page.getByTestId("gs-overlay");
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    // A step's surface stacks on the checklist; Back returns to it.
    await overlay.getByRole("button", { name: WALLET_STEP_REGEX }).click();
    const back = page.getByRole("button", { name: "Go back" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toBeHidden();
    await expect(overlay).toBeVisible();
  });

  test("opens in an overlay on the settings pages", async ({ page }) => {
    await resetLauncher(page);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await openFromUserMenu(page);

    await expect(page.getByTestId("gs-overlay")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("shares progress with the sidebar card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetLauncher(page);
    await seedLauncher(page, { state: "collapsed" });
    await openFromUserMenu(page);
    const overlay = page.getByTestId("gs-overlay");
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    // A phone turned sideways: the sidebar is back and the overlay stays.
    await page.setViewportSize({ width: 1280, height: 800 });
    const pill = page.getByTestId("gs-launcher-pill");
    await expect(pill).toContainText("0/3");
    await expect(overlay).toBeVisible();

    // A step done in the overlay shows on the pill and in the card.
    await overlay.getByRole("button", { name: WALLET_STEP_REGEX }).click();
    await expect(pill).toContainText("1/3");
    await page.getByRole("button", { name: "Go back" }).click();
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    await pill.click();
    await expect(page.getByTestId("gs-step-wallet-ready")).toHaveAttribute(
      "data-complete",
      "true"
    );
  });

  test("closes before opening a workflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetLauncher(page);
    // The first two steps done, so "Run your first workflow" is unlocked.
    await seedLauncher(page, {
      state: "collapsed",
      done: ["wallet-ready", "connect-agent"],
    });
    await openFromUserMenu(page);
    const overlay = page.getByTestId("gs-overlay");
    await overlay.getByRole("button", { name: RUN_STEP_REGEX }).click();

    await expect(page).toHaveURL(WORKFLOW_URL_REGEX, { timeout: 20_000 });
    const workflowId = new URL(page.url()).pathname.split("/").pop() ?? "";
    try {
      await expect(overlay).toBeHidden();
    } finally {
      await deleteTestWorkflow(workflowId);
    }
  });

  test("stays on a window opened while the workflow was loading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetLauncher(page);
    await seedLauncher(page, {
      state: "collapsed",
      done: ["wallet-ready", "connect-agent"],
    });
    const create = await holdWorkflowCreate(page);
    await openFromUserMenu(page);
    const overlay = page.getByTestId("gs-overlay");
    await overlay.getByRole("button", { name: RUN_STEP_REGEX }).click();
    await overlay.getByRole("button", { name: WALLET_STEP_REGEX }).click();
    const back = page.getByRole("button", { name: "Go back" });
    await expect(back).toBeVisible();

    try {
      await create.release();
      await expect(back).toBeVisible();
      expect(page.url()).not.toMatch(WORKFLOW_URL_REGEX);
    } finally {
      if (create.createdId()) {
        await deleteTestWorkflow(create.createdId());
      }
    }
  });

  test.describe("with guided tours on", () => {
    test.use({ disableTours: false });

    test("drops a tour whose workflow opened too late", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await resetLauncher(page);
      await seedLauncher(page, {
        state: "collapsed",
        done: ["wallet-ready", "connect-agent"],
      });
      const create = await holdWorkflowCreate(page);
      await openFromUserMenu(page);
      const overlay = page.getByTestId("gs-overlay");
      await overlay.getByRole("button", { name: "Take a guided tour" }).click();
      // Closed before the workflow arrives.
      await page.keyboard.press("Escape");
      await expect(overlay).toBeHidden();

      try {
        await create.release();
        expect(page.url()).not.toMatch(WORKFLOW_URL_REGEX);

        // Opening that draft later from the sidebar card starts no tour.
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.getByTestId("gs-launcher-pill").click();
        await page
          .getByTestId("gs-launcher-card")
          .getByRole("button", { name: RUN_STEP_REGEX })
          .click();
        await expect(page).toHaveURL(WORKFLOW_URL_REGEX, { timeout: 20_000 });
        await expect(
          page.locator('[data-testid="workflow-canvas"]')
        ).toBeVisible({ timeout: 20_000 });
        // A queued tour starts soon after the canvas; give it time to.
        await page.waitForTimeout(2000);
        await expect(page.getByText("Preparing your tour")).toHaveCount(0);
        await expect(page.locator(".driver-popover")).toHaveCount(0);
      } finally {
        if (create.createdId()) {
          await deleteTestWorkflow(create.createdId());
        }
      }
    });
  });
});
