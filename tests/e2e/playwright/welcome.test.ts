import { expect, test } from "./fixtures";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;
// Production builds prefix the session cookie with `__Secure-` (useSecureCookies).
const SESSION_COOKIE_NAME_RE = /^(?:__Secure-)?better-auth\.session_token$/;

test.describe("welcome landing", () => {
  test("redirects a logged-out visitor from / to /welcome", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(WELCOME_ROOT, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible();
  });

  test("offers email, wallet, and guest entry points", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    // The email/password form renders inline alongside social + wallet buttons.
    await expect(page.locator("#auth-email")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Wallet" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Explore without signing in" })
    ).toBeVisible();
  });

  test("wallet button reveals the wallet picker", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const walletButton = page.getByRole("button", { name: "Wallet" });
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    // Retry to tolerate the post-navigation hydration race on the first click.
    await expect(async () => {
      if (await walletButton.isVisible()) {
        await walletButton.click();
      }
      await expect(
        page.getByText("Nothing leaves your device but a signature.")
      ).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Other ways to sign in" })
    ).toBeVisible();
  });

  test("guest link mints an anonymous session and lands on the app", async ({
    page,
    context,
  }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const guestButton = page.getByRole("button", {
      name: "Explore without signing in",
    });
    await expect(guestButton).toBeVisible({ timeout: 15_000 });
    // Retry to tolerate the post-navigation hydration race on the first click.
    await expect(async () => {
      if (await guestButton.isVisible()) {
        await guestButton.click();
      }
      await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 4000 });
    }).toPass({ timeout: 30_000 });

    // The guest path must actually create the anonymous account: without a
    // better-auth session cookie the proxy would bounce "/" back to /welcome.
    // The production build sets a `__Secure-`-prefixed cookie (useSecureCookies),
    // so match with or without the prefix.
    const cookies = await context.cookies();
    expect(
      cookies.some((c) => SESSION_COOKIE_NAME_RE.test(c.name)),
      "guest entry did not mint an anonymous session cookie"
    ).toBe(true);

    // The session resolves to an anonymous user (name "Anonymous").
    const sessionUser = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", {
        headers: { "Content-Type": "application/json" },
      });
      const body = (await res.json().catch(() => null)) as {
        user?: { name?: string | null; isAnonymous?: boolean | null };
      } | null;
      return body?.user ?? null;
    });
    expect(sessionUser?.isAnonymous ?? sessionUser?.name === "Anonymous").toBe(
      true
    );

    // The guest is not re-walled to /welcome on reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(WELCOME_ANY, { timeout: 10_000 });
  });
});
