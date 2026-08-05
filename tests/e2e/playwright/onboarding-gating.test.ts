import { expect, test } from "./fixtures";
import {
  completeTotpEnrollment,
  fillOtpInput,
  getOtpFromDb,
  signUp,
} from "./utils/auth";

// Root gating for the welcome experience: a visitor without a real session is
// walled at /welcome instead of the bare canvas; the guest escape hatch drops
// them into the app; a returning onboarded user goes straight to the canvas;
// and a fresh signup is routed through the onboarding wizard to the canvas.

const CANVAS = '[data-testid="workflow-canvas"]';
// The org switcher is a role=combobox, but so are the wizard's Select inputs,
// so target it by its stable testid to avoid strict-mode collisions.
const ORG_SWITCHER = '[data-testid="org-switcher"]';

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;
const CREATE_ORG = /\/welcome\/create-org/;
const INVITE_MEMBERS = /\/welcome\/invite-members/;
const PAY_PER_EXECUTION = /\/welcome\/pay-per-execution/;
const CONNECT_AGENT = /\/welcome\/connect-agent/;

test.describe("welcome gating: visitors", () => {
  // Fresh anonymous browser (no persistent session).
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a logged-out visitor is walled at /welcome and never sees the canvas", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(WELCOME_ROOT, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible();
    await expect(page.locator(CANVAS)).toHaveCount(0);
  });

  test("'Explore without signing in' drops into the canvas and does not re-wall on reload", async ({
    page,
  }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    // Retry the click: right after navigation the first one can land before the
    // handler is wired and be dropped, leaving the page on /welcome.
    const guestButton = page.getByRole("button", {
      name: "Explore without signing in",
    });
    await expect(guestButton).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      if (await guestButton.isVisible()) {
        await guestButton.click();
      }
      await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Start building" })
    ).toBeVisible({ timeout: 15_000 });

    // The continue-as-guest flag persists: reloading the root does not bounce
    // the guest back to the welcome wall.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Start building" })
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("welcome gating: returning user", () => {
  // Uses the persistent (already-onboarded) test user from auth.setup.
  test("an onboarded user lands on the canvas, not the wizard", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(ORG_SWITCHER)).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(WELCOME_ANY);
  });
});

test.describe("onboarding wizard: new signup", () => {
  // Fresh anonymous browser so the signup is treated as a first-time user.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signup is routed into the wizard, and stepping through lands on the canvas", async ({
    page,
  }) => {
    const email = `test+wizard-${Date.now()}@techops.services`;
    await signUp(page, { email });

    const otp = await getOtpFromDb(email);
    await fillOtpInput(page.getByPlaceholder("123456"), otp);
    await page.locator('button[type="submit"]:has-text("Verify")').click();

    // Mandatory TOTP enrollment follows email verification for fresh signups.
    const totpRequired = await page
      .locator("#totp-verify-code")
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (totpRequired) {
      await completeTotpEnrollment(page);
      // The /enroll-mfa success card auto-redirects after a countdown; click
      // Continue to proceed immediately when it is shown.
      const enrollContinue = page.getByRole("button", { name: "Continue" });
      if (await enrollContinue.isVisible().catch(() => false)) {
        await enrollContinue.click();
      }
    }

    // The gating routes a first-time user into the onboarding wizard.
    await expect(page).toHaveURL(CREATE_ORG, { timeout: 25_000 });

    // Advance past a step by clicking its control, retrying to tolerate the
    // hydration race where the first click after a load is dropped.
    const advance = async (
      buttonName: string,
      expectedUrl: RegExp
    ): Promise<void> => {
      const control = page.getByRole("button", { name: buttonName });
      await expect(async () => {
        if (await control.isVisible()) {
          await control.click();
        }
        await expect(page).toHaveURL(expectedUrl, { timeout: 4000 });
      }).toPass({ timeout: 30_000 });
    };

    // Walk one step per call. Only the first two steps are skippable; the
    // pay-per-execution step has no skip because pay-as-you-go covers every
    // free org, so it is advanced with its own control.
    await advance("Skip", INVITE_MEMBERS);
    await advance("Skip", PAY_PER_EXECUTION);
    await advance("Continue", CONNECT_AGENT);

    // Finish marks onboarding complete and lands the user on the canvas.
    const finishButton = page.getByRole("button", { name: "Finish" });
    await expect(async () => {
      if (await finishButton.isVisible()) {
        await finishButton.click();
      }
      await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.locator(ORG_SWITCHER)).toBeVisible({ timeout: 20_000 });
  });
});
