import { expect, test } from "./fixtures";

// The sign-in surface moved from an in-app modal to the inline /welcome
// landing (SignInChoices + ConnectAuthPanel). These cover the email
// signup/verify and sign-in flows on that page. Run serially to avoid session
// state conflicts between the signup flows.
test.describe.configure({ mode: "serial" });

const newEmail = (): string => `test+${Date.now()}@techops.services`;

const VERIFY_ERROR_REGEX = /verify/i;

// Right after navigation the "Create an account" toggle can be clicked before
// the client handler is wired, dropping the click and leaving the main
// (sign-in) view in place. Retry the toggle until the signup heading resolves.
async function openSignupView(
  page: import("@playwright/test").Page
): Promise<void> {
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(async () => {
    if (await toggle.isVisible()) {
      await toggle.click();
    }
    await expect(heading).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 20_000 });
}

// Sign in, retrying until the expected outcome resolves. Two hydration races
// are handled each attempt: a too-early controlled-input fill can be dropped
// before onChange is wired (React state stays empty even though the DOM shows a
// value, so the submit posts empty credentials), and the submit click can land
// before its handler is wired. Re-fill both fields then submit on every attempt.
// The submit is targeted by type -- the sign-up view's "Already have an account?
// Sign in" toggle shares the name -- and turns into a spinner (no "Sign in"
// text) while the request is in flight. Pass a text-specific outcome so an
// empty-credential "required" error does not satisfy it.
async function signInUntil(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
  outcome: import("@playwright/test").Locator
): Promise<void> {
  const emailField = page.locator("#auth-email");
  const passwordField = page.locator("#auth-password");
  const signInButton = page.locator('button[type="submit"]', {
    hasText: "Sign in",
  });
  await expect(async () => {
    await emailField.fill(email);
    await passwordField.fill(password);
    if (await signInButton.isVisible()) {
      await signInButton.click();
    }
    await expect(outcome).toBeVisible({ timeout: 8000 });
  }).toPass({ timeout: 30_000 });
}

test.describe("Authentication", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test.describe("Email OTP Verification on Signup", () => {
    test("shows verification view after signup with OTP input", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });

      // The email/password form renders inline; switch it to the sign-up view.
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);

      await page.locator("#auth-email").fill(newEmail());
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      // Verify view: heading, OTP input, a confirmation toast, and resend.
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByPlaceholder("123456")).toBeVisible();
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.getByRole("button", { name: "Resend code" })
      ).toBeVisible();
    });

    test("invalid email keeps the user on the signup view", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);

      await page.locator("#auth-email").fill("invalid-email");
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      // HTML5 email validation blocks submission, so the signup view stays.
      await expect(
        page.getByRole("heading", { name: "Create your account" })
      ).toBeVisible();
    });

    test("existing unverified user signing up again returns to verification", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      const email = newEmail();

      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill("TestPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });

      // Reload to reset the panel to the sign-in view (the verify view has no
      // back button), then sign up again with the same (still unverified)
      // email: the panel returns to verification rather than erroring.
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill("DifferentPassword123!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();

      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe("Sign In", () => {
    test("renders the email and password form inline", async ({ page }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("#auth-password")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true })
      ).toBeVisible();
    });

    test("shows error for incorrect credentials", async ({ page }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await signInUntil(
        page,
        "nonexistent@example.com",
        "WrongPassword123!",
        page.locator(".text-destructive")
      );
    });

    test("unverified user signing in is told to verify their email", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      const email = newEmail();
      const password = "TestPassword123!";

      // Create an unverified account.
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      await openSignupView(page);
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill(password);
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Verify your email" })
      ).toBeVisible({ timeout: 15_000 });

      // Reload to reset the panel to the sign-in view, then sign in with the
      // still-unverified account. strict-signin/start rejects it as
      // email_not_verified, which the panel surfaces as an inline error on the
      // sign-in view (email verification is a prerequisite before sign-in).
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#auth-email")).toBeVisible({
        timeout: 15_000,
      });
      // The outcome is the verify-specific error so an empty-credential
      // "required" error (from a hydration-dropped fill) does not satisfy it.
      const error = page.locator(".text-destructive", {
        hasText: VERIFY_ERROR_REGEX,
      });
      await signInUntil(page, email, password, error);
      await expect(error).toBeVisible();
    });

    test("can navigate between sign in and create account views", async ({
      page,
    }) => {
      await page.goto("/welcome", { waitUntil: "domcontentloaded" });

      // Both forms stay mounted, so "Sign in" matches the submit button and the
      // signup view's "Already have an account? Sign in" toggle. Target the
      // submit by type and the toggle by its paragraph to stay unambiguous.
      const signInSubmit = page.locator('button[type="submit"]', {
        hasText: "Sign in",
      });
      const backToSignIn = page
        .getByRole("paragraph")
        .filter({ hasText: "Already have an account?" })
        .getByRole("button", { name: "Sign in" });

      await expect(signInSubmit).toBeVisible({ timeout: 15_000 });

      await openSignupView(page);

      await backToSignIn.click();
      await expect(signInSubmit).toBeVisible();
    });
  });
});
