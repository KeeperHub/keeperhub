import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import postgres from "postgres";

/**
 * Sign up a new user and navigate to verification view.
 * Returns the test email for later use.
 */
export async function signUp(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string }> {
  const testEmail = options?.email ?? `test+${Date.now()}@techops.services`;
  const testPassword = options?.password ?? "TestPassword123!";

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const signInButton = page.locator('button:has-text("Sign In")').first();
  await expect(signInButton).toBeVisible({ timeout: 15_000 });
  await signInButton.click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Switch to signup view
  const createAccountLink = dialog.locator('button:has-text("Create account")');
  await createAccountLink.click();

  // Fill in signup form
  await dialog.locator("#signup-email").fill(testEmail);
  await dialog.locator("#signup-password").fill(testPassword);

  // Submit the form
  await dialog
    .locator('button[type="submit"]:has-text("Create account")')
    .click();

  // Wait for verify view
  const dialogTitle = dialog.locator("h2");
  await expect(dialogTitle).toHaveText("Verify your email", {
    timeout: 15_000,
  });

  return { email: testEmail, password: testPassword };
}

/**
 * Get OTP from database for a given email.
 * Requires DATABASE_URL environment variable.
 */
export async function getOtpFromDb(email: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const identifier = `email-verification-otp-${email}`;
    const result = await sql`
      SELECT value FROM verifications
      WHERE identifier = ${identifier}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      throw new Error(`No verification found for email: ${email}`);
    }

    const rawValue = result[0].value as string;
    if (!rawValue) {
      throw new Error(`No OTP found for email: ${email}`);
    }

    // Value format is "OTP:attempts", extract just the OTP
    const otp = rawValue.split(":")[0];
    return otp;
  } finally {
    await sql.end();
  }
}

/**
 * Sign up a new user and verify with OTP from database.
 * Returns authenticated user details.
 */
export async function signUpAndVerify(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string }> {
  const { email, password } = await signUp(page, options);

  // Get OTP from database
  const otp = await getOtpFromDb(email);

  // Enter OTP
  const dialog = page.locator('[role="dialog"]');
  const otpInput = dialog.locator("#otp");
  await otpInput.fill(otp);

  // Click verify
  const verifyButton = dialog.locator(
    'button[type="submit"]:has-text("Verify")'
  );
  await verifyButton.click();

  // Wait for dialog to close (successful verification)
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  // Wait for org switcher to appear (org auto-created after first sign-in)
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });

  return { email, password };
}

/**
 * Sign in with existing credentials.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const signInButton = page.locator('button:has-text("Sign In")').first();
  await expect(signInButton).toBeVisible({ timeout: 15_000 });
  await signInButton.click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  await dialog.locator("#email").fill(email);
  await dialog.locator("#password").fill(password);
  await dialog.locator('button[type="submit"]:has-text("Sign in")').click();

  // Wait for dialog to close (successful sign in)
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  // Wait for org switcher to appear (indicates session and org are resolved)
  await expect(page.locator('[data-testid="org-switcher"]')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Sign out the current user.
 */
export async function signOut(page: Page): Promise<void> {
  // Look for user menu or sign out button
  const userMenu = page.locator('[data-testid="user-menu"]');
  if (await userMenu.isVisible()) {
    await userMenu.click();
    const signOutButton = page.locator('button:has-text("Sign out")');
    await signOutButton.click();
    await expect(signOutButton).not.toBeVisible({ timeout: 5000 });
  }
}

/**
 * Check if user is currently authenticated.
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  // Check for authenticated UI elements
  const signInButton = page.locator('button:has-text("Sign In")').first();
  const userMenu = page.locator('[data-testid="user-menu"]');

  // If sign in button is visible, user is not authenticated
  if (await signInButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    return false;
  }

  // If user menu is visible, user is authenticated
  if (await userMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }

  return false;
}
