import { createHmac } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { symmetricDecrypt } from "better-auth/crypto";
import postgres from "postgres";
import { getAdminFetchHeaders } from "./admin-fetch";

const WELCOME_URL_REGEX = /\/welcome/;

/**
 * Switch the inline /welcome panel from the sign-in view to the sign-up view.
 * Right after navigation the "Create an account" toggle can be clicked before
 * the client handler is wired, dropping the click and leaving the sign-in view
 * in place; retry until the signup heading resolves.
 */
export async function openSignupView(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(async () => {
    if (await toggle.isVisible()) {
      await toggle.click();
    }
    await expect(heading).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Enter the app as an anonymous guest from /welcome. The "Explore without
 * signing in" button mints an anonymous session then navigates to "/"; the
 * first click can race hydration, so retry until we leave /welcome.
 */
export async function enterAsGuest(page: Page): Promise<void> {
  await page.goto("/welcome", { waitUntil: "domcontentloaded" });
  const guest = page.getByRole("button", {
    name: "Explore without signing in",
  });
  await expect(guest).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if (await guest.isVisible()) {
      await guest.click();
    }
    await expect(page).not.toHaveURL(WELCOME_URL_REGEX, { timeout: 4000 });
  }).toPass({ timeout: 30_000 });
}

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

  // Suppress the driver.js tour so its backdrop doesn't intercept modal clicks.
  await page
    .context()
    .addCookies([
      { name: "kh_disable_tours", value: "1", url: "http://localhost:3000" },
    ]);
  // Logged-out visitors land on /welcome, which renders the shared
  // SignInChoices panel inline. Open the email panel, switch to the sign-up
  // view, and submit; the verify view then shows the OTP input.
  await page.goto("/welcome", { waitUntil: "domcontentloaded" });

  // The sign-in form renders inline; switch it to the sign-up view.
  await openSignupView(page);

  await page.locator("#auth-email").fill(testEmail);
  await page.locator("#auth-password").fill(testPassword);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  // Verify view: the OTP input (a plain field, keyed by its placeholder) is the
  // unambiguous signal it rendered.
  await expect(page.getByPlaceholder("123456")).toBeVisible({
    timeout: 15_000,
  });

  return { email: testEmail, password: testPassword };
}

/**
 * Get OTP for a given email.
 * Uses admin API when TEST_API_KEY + BASE_URL are set (remote/deployed mode).
 * Falls back to direct DB query when DATABASE_URL is available (local mode).
 */
export async function getOtpFromDb(email: string): Promise<string> {
  const adminKey = process.env.TEST_API_KEY;
  const baseUrl = process.env.BASE_URL;

  if (adminKey && baseUrl) {
    return await getOtpViaApi(email, baseUrl);
  }

  return await getOtpViaDb(email);
}

async function getOtpViaApi(email: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl}/api/admin/test/otp?email=${encodeURIComponent(email)}`;
  const maxRetries = 8;
  const baseDelay = 500;

  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, { headers: getAdminFetchHeaders() });
    if (response.ok) {
      const data = (await response.json()) as { otp: string };
      return data.otp;
    }
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`Admin OTP API returned ${response.status}: ${body}`);
    }
    const delay = Math.min(baseDelay * 2 ** i, 4000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(
    `No OTP found for ${email} after ${maxRetries} retries via API`
  );
}

async function getEncryptedOtpFromDb(identifier: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or TEST_API_KEY+BASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const result = await sql`
      SELECT value FROM verifications
      WHERE identifier = ${identifier}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      throw new Error(`No verification found for identifier: ${identifier}`);
    }

    const rawValue = result[0].value as string;
    if (!rawValue) {
      throw new Error(`No OTP found for identifier: ${identifier}`);
    }

    // Better Auth's emailOTP plugin stores the value as `<encrypted>:<keyVersion>`
    // when storeOTP is "encrypted" (lib/auth.ts, KEEP-625). Strip the version
    // suffix and symmetric-decrypt the ciphertext with BETTER_AUTH_SECRET to
    // recover the plaintext 6-digit code -- the same primitive the app's
    // strict-signin verifier uses to read it back.
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      throw new Error("BETTER_AUTH_SECRET is required to decrypt the OTP");
    }
    const ciphertext = rawValue.split(":")[0];
    const otp = await symmetricDecrypt({ key: secret, data: ciphertext });
    return otp;
  } finally {
    await sql.end();
  }
}

/**
 * Read and decrypt the forgot-password reset code. The route stores it under the
 * bare email identifier, not a prefixed one.
 */
export async function getResetOtpFromDb(email: string): Promise<string> {
  return await getEncryptedOtpFromDb(email);
}

/**
 * Read and decrypt a dual-factor email OTP, keyed `mfa:<action>:<userId>` by
 * lib/mfa/dual-factor.ts. Resolves the user id from the email first.
 */
export async function getDualFactorOtpFromDb(
  email: string,
  action: string
): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = postgres(databaseUrl, { max: 1 });
  let userId: string;
  try {
    const rows = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (rows.length === 0) {
      throw new Error(`No user found for ${email}`);
    }
    userId = rows[0].id as string;
  } finally {
    await sql.end();
  }
  // The row is written as the challenge is issued, so poll briefly.
  let lastError: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      return await getEncryptedOtpFromDb(`mfa:${action}:${userId}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function getOtpViaDb(email: string): Promise<string> {
  return await getEncryptedOtpFromDb(`email-verification-otp-${email}`);
}

/**
 * Read and decrypt the strict-signin email OTP (identifier
 * `sign-in-otp-<email>`) that /api/auth/strict-signin/start seeds. DB-only: the
 * admin OTP API only exposes the email-verification code, so the sign-in factor
 * must be read straight from the verifications table. Requires DATABASE_URL +
 * BETTER_AUTH_SECRET (both present in the e2e job).
 */
export async function getSignInOtpFromDb(email: string): Promise<string> {
  return await getEncryptedOtpFromDb(`sign-in-otp-${email}`);
}

/**
 * Fill a (possibly segmented) OTP input reliably. The shadcn InputOTP component
 * intermittently drops digits when populated with a single fill(), which leaves
 * the submit button disabled and hangs the subsequent click. Type the code and
 * assert it landed, retrying the whole sequence until the input holds the full
 * value.
 */
export async function fillOtpInput(
  otpInput: Locator,
  otp: string
): Promise<void> {
  await expect(async () => {
    await otpInput.fill("");
    await otpInput.pressSequentially(otp, { delay: 25 });
    await expect(otpInput).toHaveValue(otp);
  }).toPass({ timeout: 15_000 });
}

/**
 * Fill the sign-in email-OTP field (components/auth/email-otp-field.tsx). That
 * field is a `<div contentEditable>` (deliberately not an <input>, so password
 * managers cannot autofill it), so it has no `value` -- type into it and assert
 * its text, retrying until the digits land.
 */
export async function fillContentEditableOtp(
  field: Locator,
  otp: string
): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.press("ControlOrMeta+a");
    await field.pressSequentially(otp, { delay: 25 });
    await expect(field).toHaveText(otp);
  }).toPass({ timeout: 15_000 });
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_PAD_REGEX = /=+$/;
const TOTP_PERIOD_SECONDS = 30;

/**
 * Decode an RFC 4648 base32 string (no padding) to its raw bytes. The TOTP
 * setup key the enrollment dialog renders is base32EncodeUtf8(secret); decoding
 * it yields the exact HMAC key the server verifies against (the app stores the
 * secret and uses it directly as the HMAC key -- see lib/security/totp-verify).
 */
function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(BASE32_PAD_REGEX, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      continue;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate the current 6-digit TOTP for a base32 setup key, matching the
 * server's RFC 6238 implementation (HMAC-SHA1, 30s period, dynamic truncation).
 * Validated against the app's generateTotp for byte-identical output.
 */
export function generateTotpCode(manualEntryKey: string): string {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(manualEntryKey))
    .update(counter)
    .digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (truncated % 1_000_000).toString().padStart(6, "0");
}

/**
 * Complete the mandatory TOTP enrollment wizard that follows a fresh signup
 * (components/settings/totp-setup-dialog.tsx). Reads the rendered setup key,
 * submits a matching code, and dismisses the backup-codes step so the auth
 * dialog closes. Assumes the enrollment step is already on screen. Returns the
 * base32 setup key so callers can generate codes for a later sign-in step-up.
 */
export async function completeTotpEnrollment(page: Page): Promise<string> {
  const dialog = page.locator('[role="dialog"]');
  const manualEntryKey = (
    await dialog
      .locator('button[aria-label="Copy setup key"]')
      .first()
      .textContent()
  )?.replace(/\s/g, "");
  if (!manualEntryKey) {
    throw new Error("Could not read the TOTP setup key from the dialog");
  }
  await page
    .locator("#totp-verify-code")
    .fill(generateTotpCode(manualEntryKey));
  await dialog.locator('button:has-text("Continue")').click();
  // Backup-codes step: confirm it to finish enrollment and close the dialog.
  const finishButton = dialog.locator('button:has-text("Done")');
  await expect(finishButton).toBeVisible({ timeout: 15_000 });
  await finishButton.click();
  return manualEntryKey;
}

/**
 * Sign up a new user and verify with OTP from database.
 * Returns authenticated user details plus the TOTP setup key from the mandatory
 * enrollment step (empty string if enrollment did not appear), so callers can
 * later drive this user through a sign-in TOTP step-up.
 */
export async function signUpAndVerify(
  page: Page,
  options?: { email?: string; password?: string }
): Promise<{ email: string; password: string; totpKey: string }> {
  const { email, password } = await signUp(page, options);

  // Get OTP from database
  const otp = await getOtpFromDb(email);

  // Enter OTP. On /welcome the verify view is inline in the panel (no dialog),
  // and the field is keyed by its placeholder rather than an id.
  const otpInput = page.getByPlaceholder("123456");
  await fillOtpInput(otpInput, otp);

  await page.locator('button[type="submit"]:has-text("Verify")').click();

  // Fresh signups are forced through TOTP enrollment after email verification
  // (components/settings/totp-setup-dialog.tsx). Complete it when it appears so
  // the enrollment dialog can close; gated so any flow without it is unaffected.
  const totpRequired = await page
    .locator("#totp-verify-code")
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  let totpKey = "";
  if (totpRequired) {
    totpKey = await completeTotpEnrollment(page);
  }

  // A fresh signup is routed into the onboarding wizard by the welcome gating.
  // Mark onboarding complete so this helper lands the user on the canvas,
  // preserving its contract for the tests that build on a signed-in session.
  await page.request.post("/api/user/onboarding/complete", {
    headers: { Origin: new URL(page.url()).origin },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Wait for org switcher to appear (org auto-created after first sign-in)
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });

  return { email, password, totpKey };
}

/**
 * Drive the shared AuthDialog through the full strict three-factor sign-in
 * (password -> email OTP -> TOTP) for an existing, TOTP-enrolled user. Assumes
 * the dialog is already open on the sign-in view. Does not assert post-sign-in
 * navigation -- the redirect target depends on the entry point that opened it.
 */
export async function completeMfaSignInDialog(
  page: Page,
  credentials: { email: string; password: string; totpKey: string }
): Promise<void> {
  // The shared auth dialog renders SignInChoices / ConnectAuthPanel, whose
  // strict sign-in walks password -> email OTP -> TOTP as animated views.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog.locator("#auth-password")).toBeVisible({
    timeout: 15_000,
  });
  await dialog.locator("#auth-email").fill(credentials.email);
  await dialog.locator("#auth-password").fill(credentials.password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();

  // Email-OTP factor (view "mfa-email"): strict-signin/start seeded a
  // `sign-in-otp` row; read and submit it once the email-code step renders.
  await expect(
    dialog.getByRole("heading", { name: "Check your email" })
  ).toBeVisible({ timeout: 15_000 });
  await dialog
    .getByPlaceholder("123456")
    .fill(await getSignInOtpFromDb(credentials.email));
  await dialog.getByRole("button", { name: "Continue" }).click();

  // TOTP factor (view "mfa-totp"): generate the current code from the secret.
  // The final step's submit is labeled "Sign in" (it completes the sign-in).
  await expect(
    dialog.getByRole("heading", { name: "Authenticator code" })
  ).toBeVisible({ timeout: 15_000 });
  await dialog
    .getByPlaceholder("123456")
    .fill(generateTotpCode(credentials.totpKey));
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Sign in with existing credentials.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  // Suppress the driver.js onboarding tour so its backdrop doesn't intercept
  // clicks inside the Connect modal (auth.setup doesn't load the fixture that
  // sets this cookie).
  await page.context().addCookies([
    {
      name: "kh_disable_tours",
      value: "1",
      url: "http://localhost:3000",
    },
  ]);
  // Logged-out visitors are routed to the /welcome landing, which renders the
  // shared SignInChoices panel inline (no modal). Open the email panel and sign
  // in with credentials; on success the panel navigates to "/".
  await page.goto("/welcome", { waitUntil: "domcontentloaded" });

  // The email/password form renders inline (no chooser step on the landing).
  const emailField = page.locator("#auth-email");
  const passwordField = page.locator("#auth-password");
  const orgSwitcher = page.locator('button[role="combobox"]');

  // An existing session redirects /welcome straight into the app, so there is
  // no form to fill. Wait for whichever of the two lands and take that branch.
  await expect(emailField.or(orgSwitcher).first()).toBeVisible({
    timeout: 15_000,
  });
  if (await orgSwitcher.isVisible()) {
    return;
  }

  // Retry the fill and the submit together: a fill that lands before hydration
  // is wiped when React mounts the controlled inputs, and a click that lands
  // before the handler is wired is dropped. Re-filling every attempt keeps the
  // loop from clicking an empty form against native required validation.
  const signInButton = page.getByRole("button", {
    name: "Sign in",
    exact: true,
  });
  await expect(async () => {
    if (await signInButton.isVisible()) {
      await emailField.fill(email);
      await passwordField.fill(password);
      await signInButton.click();
    }
    // Give a submit that did land time to resolve before re-clicking, so a slow
    // sign-in is not mistaken for a dropped click and re-submitted needlessly.
    await expect(orgSwitcher).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Sign out the current user.
 */
export async function signOut(page: Page): Promise<void> {
  const userMenu = page.locator('[data-testid="user-menu"]');
  await expect(userMenu).toBeVisible({ timeout: 5000 });
  await userMenu.click();
  const signOutButton = page.locator('button:has-text("Sign out")');
  await expect(signOutButton).toBeVisible({ timeout: 5000 });
  await signOutButton.click();
  await expect(signOutButton).not.toBeVisible({ timeout: 5000 });
}

/**
 * Check if user is currently authenticated.
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  // Check for authenticated UI elements. Logged-out users see the Connect
  // button (which replaced the bare "Sign In" button).
  const connectButton = page
    .getByRole("button", { name: "Connect", exact: true })
    .first();
  const userMenu = page.locator('[data-testid="user-menu"]');

  // If the Connect button is visible, user is not authenticated
  if (await connectButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    return false;
  }

  // If user menu is visible, user is authenticated
  if (await userMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }

  return false;
}
