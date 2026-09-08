import { expect, test } from "./fixtures";
import {
  fillContentEditableOtp,
  generateTotpCode,
  getDualFactorOtpFromDb,
  getResetOtpFromDb,
  getSignInOtpFromDb,
  signUpAndVerify,
} from "./utils/auth";

const RESET_PASSWORD = "ResetPass456!";
const CHANGED_PASSWORD = "ChangedPass789!";

/**
 * End-to-end cover for every password flow a credential user can reach: signup
 * with mandatory TOTP enrollment, three-factor sign-in, self-service recovery,
 * and an authenticated password change. These are UI-contract tests; route-level
 * tests cannot see a form wired to a field that no longer renders.
 */
test.describe("email and password auth flow", () => {
  // The chromium project loads a signed-in storageState. These tests create
  // their own users and start from /welcome, which only serves the sign-up view
  // to logged-out visitors, so the inherited session has to go first.
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("signup verifies email and enrolls TOTP before granting a session", async ({
    page,
  }) => {
    const { email, totpKey } = await signUpAndVerify(page);

    expect(email).toContain("@");
    // Enrollment is mandatory, so every credential user has a second factor.
    expect(totpKey).not.toBe("");
    await expect(page.locator('button[role="combobox"]')).toBeVisible();
  });

  test("recovery: reset needs the email code only, and the old password stops working", async ({
    page,
    context,
  }) => {
    const { email, password, totpKey } = await signUpAndVerify(page);
    await context.clearCookies();
    await page.goto("/welcome");

    await page.locator("#auth-email").fill(email);
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(
      page.getByRole("heading", { name: "Reset your password" })
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Send reset code" }).click();

    await expect(
      page.getByRole("heading", { name: "Enter your reset code" })
    ).toBeVisible({ timeout: 15_000 });

    const codeField = page.getByPlaceholder("Reset code");
    const newField = page.getByPlaceholder("New password", { exact: true });
    const confirmField = page.getByPlaceholder("Confirm new password");
    const submit = page.getByRole("button", { name: "Reset password" });

    // Mismatched confirmation is rejected before any request goes out.
    await codeField.fill("000000");
    await newField.fill(RESET_PASSWORD);
    await confirmField.fill(`${RESET_PASSWORD}x`);
    await submit.click();
    await expect(page.getByText(/Passwords do not match/i)).toBeVisible();

    // Short passwords are rejected too.
    await newField.fill("short");
    await confirmField.fill("short");
    await submit.click();
    await expect(
      page.getByText(/at least 8 characters/i).first()
    ).toBeVisible();

    // A wrong reset code is rejected by the server.
    await newField.fill(RESET_PASSWORD);
    await confirmField.fill(RESET_PASSWORD);
    await submit.click();
    await expect(
      page.getByText(/Invalid or expired verification code/i)
    ).toBeVisible({ timeout: 15_000 });

    // The real code completes the reset with no authenticator prompt. The reset
    // step renders no such field, so demanding one is a dead end for the user.
    await codeField.fill(await getResetOtpFromDb(email));
    await newField.fill(RESET_PASSWORD);
    await confirmField.fill(RESET_PASSWORD);
    await submit.click();
    await expect(page.getByText(/two-factor enabled/i)).toBeHidden();
    // The panel returns to the sign-in view. Its header is suppressed there on
    // /welcome, so the form itself is the signal.
    await expect(page.getByPlaceholder("Reset code")).toBeHidden({
      timeout: 15_000,
    });
    await expect(page.locator("#auth-password")).toBeVisible();

    // The superseded password must not authenticate.
    await signInWithPassword(page, email, password);
    await expect(page.locator(".text-destructive")).toBeVisible({
      timeout: 15_000,
    });

    // The reset leaves the enrolled factor intact, which is what makes it safe
    // to accept the email code alone above: sign-in still walks password, then
    // email code, then authenticator.
    await page.locator("#auth-password").fill(RESET_PASSWORD);
    await page.locator('button[type="submit"]', { hasText: "Sign in" }).click();
    await completeEmailOtpStep(page, email);
    await completeTotpStep(page, totpKey);

    await expect(page.locator('button[role="combobox"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test("authenticated password change requires the current password plus both factors", async ({
    page,
  }) => {
    const { email, password, totpKey } = await signUpAndVerify(page);

    await page.goto("/settings/security", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#currentPassword")).toBeVisible({
      timeout: 20_000,
    });

    await page.locator("#currentPassword").fill(password);
    await page.locator("#newPassword").fill(CHANGED_PASSWORD);
    await page.locator("#confirmPassword").fill(CHANGED_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();

    // Dual factor runs as two phases, email code then authenticator. The email
    // field is a contentEditable div so password managers cannot autofill it.
    const emailField = page.locator("#dfs-email-verify");
    await expect(emailField).toBeVisible({ timeout: 20_000 });
    await fillContentEditableOtp(
      emailField,
      await getDualFactorOtpFromDb(email, "password_change")
    );

    await page.getByRole("button", { name: "Continue" }).click();

    const totpField = page.locator("#dfs-totp");
    await expect(totpField).toBeVisible({ timeout: 15_000 });
    await totpField.fill(generateTotpCode(totpKey));
    await page.getByRole("button", { name: "Change password" }).click();

    // A successful change signs every session out and returns to the root.
    await expect(page.getByText(/Password changed successfully/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('button[role="combobox"]')).toBeHidden({
      timeout: 20_000,
    });
  });
});

async function signInWithPassword(
  page: import("@playwright/test").Page,
  email: string,
  password: string
): Promise<void> {
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.locator('button[type="submit"]', { hasText: "Sign in" }).click();
}

async function completeEmailOtpStep(
  page: import("@playwright/test").Page,
  email: string
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Check your email" })
  ).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("123456").fill(await getSignInOtpFromDb(email));
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeTotpStep(
  page: import("@playwright/test").Page,
  totpKey: string
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Authenticator code" })
  ).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("123456").fill(generateTotpCode(totpKey));
  await page.locator('button[type="submit"]', { hasText: "Sign in" }).click();
}
