import { expect, test } from "./fixtures";

// Re-enable the onboarding tours for this file. The rest of the suite disables
// them by default (see fixtures.ts) so the driver.js overlay never blocks
// unrelated tests. The launcher comes back too, since the tour starts from its
// "Take a tour" button.
test.use({ disableGettingStarted: false, disableTours: false });

const WORKFLOW_EDITOR_URL_REGEX = /\/workflows\/[^/]+/;

test.describe("onboarding: editor walkthrough", () => {
  // Signed in via the persistent test user (default project storageState).
  test("launches from the getting-started launcher 'Take a tour' button", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The tour is offered on the "run-workflow" step, which is locked until the
    // earlier agent-branch steps complete. Seed the launcher state (keyed by the
    // signed-in user id) with those two click-driven steps already done so the
    // step unlocks and its "Take a guided tour" footer button renders. Also
    // clear the seen flag so the walkthrough actually starts.
    const userId = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session");
      const body = (await res.json().catch(() => null)) as {
        user?: { id?: string };
      } | null;
      return body?.user?.id ?? null;
    });
    await page.evaluate((uid) => {
      localStorage.setItem(
        `kh:getting-started:v2:${uid ?? "anon"}`,
        JSON.stringify({
          state: "expanded",
          branch: "agent",
          done: ["wallet-ready", "connect-agent"],
          workflows: {},
        })
      );
      localStorage.removeItem("keeperhub-editor-tour-seen");
    }, userId);
    await page.reload({ waitUntil: "domcontentloaded" });

    // The launcher opens expanded; launch the tour from the unlocked step footer.
    await expect(page.getByTestId("gs-launcher-card")).toBeVisible({
      timeout: 20_000,
    });
    const takeTour = page
      .getByRole("button", { name: "Take a guided tour" })
      .first();
    await expect(takeTour).toBeVisible({ timeout: 20_000 });
    await takeTour.click();

    // The launcher's contract: spin up a fresh workflow and enter the editor,
    // where the guided walkthrough runs. Assert the handoff into the editor (the
    // driver.js tour steps themselves provision a wallet and are covered by the
    // walkthrough's own logic; they are too environment-heavy to drive here).
    await expect(page).toHaveURL(WORKFLOW_EDITOR_URL_REGEX, {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="workflow-canvas"]')).toBeVisible({
      timeout: 20_000,
    });
  });
});
