import { expect, test } from "./fixtures";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;
// Production builds prefix the session cookie with `__Secure-` (useSecureCookies).
const SESSION_COOKIE_NAME_RE = /^(?:__Secure-)?better-auth\.session_token$/;
const SOCIAL_OPTION_REGEX = /^(Google|GitHub|Wallet)$/;

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

test.describe("welcome landing on a phone", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });

  test("shows the sign-in form without the desktop warning", async ({
    page,
  }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#auth-email")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Desktop Optimized")).toHaveCount(0);

    // Every sign-in option stays on one row, with nothing clipped and no
    // sideways scroll.
    const options = page.getByRole("button", {
      name: SOCIAL_OPTION_REGEX,
    });
    const boxes = await options.evaluateAll((buttons) =>
      buttons.map((button) => ({
        top: Math.round(button.getBoundingClientRect().top),
        clipped: button.scrollWidth > button.clientWidth,
      }))
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    expect(boxes.some((box) => box.clipped)).toBe(false);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The Google mark is an image, which a squeezed button used to shrink.
    const googleIcon = page
      .getByRole("button", { name: "Google", exact: true })
      .locator("img");
    if ((await googleIcon.count()) > 0) {
      const box = await googleIcon.boundingBox();
      expect(box?.width).toBe(16);
    }
  });

  test("still warns once the visitor leaves the welcome page", async ({
    page,
  }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
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
    await expect(page.getByText("Desktop Optimized")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("captcha fits the sign-up form", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const createAccount = page.getByRole("button", {
      name: "Create an account",
    });
    await expect(createAccount).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      await createAccount.click({ timeout: 2000 }).catch(() => undefined);
      await expect(page.locator("#auth-password")).toHaveAttribute(
        "autocomplete",
        "new-password",
        { timeout: 4000 }
      );
    }).toPass({ timeout: 30_000 });

    const captcha = page.getByTestId("signup-captcha");
    test.skip(
      (await captcha.count()) === 0,
      "this build has no captcha site key"
    );
    // The normal widget is 300px wide; the form here is narrower.
    await expect(captcha).toHaveAttribute("data-size", "compact");
    const form = await page.locator("form").boundingBox();
    const box = await captcha.boundingBox();
    expect(box && form && box.x + box.width <= form.x + form.width).toBe(true);
  });

  test("wallet picker shows the MetaMask icon", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    const walletButton = page.getByRole("button", { name: "Wallet" });
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      if (await walletButton.isVisible()) {
        await walletButton.click();
      }
      await expect(
        page.getByText("Nothing leaves your device but a signature.")
      ).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    // A malformed SVG fails to decode and leaves a 0-wide image.
    const icon = page.locator('img[src*="metamask"]').first();
    await expect(icon).toBeVisible();
    await expect
      .poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test("renders when the browser blocks site storage", async ({ page }) => {
    // With site data blocked, touching storage throws a SecurityError. A hook
    // mounted on every route used to let that escape and crash the page.
    await page.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, name, {
          configurable: true,
          get() {
            throw new DOMException(
              "The operation is insecure.",
              "SecurityError"
            );
          },
        });
      }
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#auth-email")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
