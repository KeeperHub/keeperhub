import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;
// Production builds prefix the session cookie with `__Secure-` (useSecureCookies).
const SESSION_COOKIE_NAME_RE = /^(?:__Secure-)?better-auth\.session_token$/;
const CLIENT_ERROR_REGEX = /Application error/;
const SOCIAL_OPTION_REGEX = /^(Google|GitHub|Wallet)$/;

// Opens "Create your account". The form is server-rendered, so a working click
// is also the proof that the page has hydrated and its effects have run.
async function openSignUp(page: Page): Promise<void> {
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
}

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
    // A malformed SVG fails to decode and leaves a 0-wide image.
    const metamask = page.locator('img[src*="metamask"]').first();
    await expect(metamask).toBeVisible();
    await expect
      .poll(() =>
        metamask.evaluate((img: HTMLImageElement) => img.naturalWidth)
      )
      .toBeGreaterThan(0);
  });

  test("renders when the browser blocks site storage", async ({ page }) => {
    // With site data blocked, touching storage throws a SecurityError. A hook
    // mounted on every route used to let that escape after hydration, and the
    // server-rendered form was replaced by Next's client error page.
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
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await openSignUp(page);
    await expect(page.getByText(CLIENT_ERROR_REGEX)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
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

  test("keeps the sign-in options on one row", async ({ page }) => {
    // The options stay side by side on every phone, by design.
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#auth-email")).toBeVisible({ timeout: 15_000 });
    const tops = await page
      .getByRole("button", { name: SOCIAL_OPTION_REGEX })
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top))
      );
    expect(tops.length).toBeGreaterThan(0);
    expect(new Set(tops).size).toBe(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("keeps the Google icon at full size", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#auth-email")).toBeVisible({ timeout: 15_000 });
    const google = page.getByRole("button", { name: "Google", exact: true });
    test.skip(
      (await google.count()) === 0,
      "this build has Google sign-in turned off"
    );
    // The mark is an image, which a squeezed button used to shrink to 0px.
    const box = await google.locator("img").boundingBox();
    expect(box?.width).toBe(16);
  });

  test("does not cover the sign-in form with the desktop warning", async ({
    page,
  }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await openSignUp(page);
    await expect(page.getByText("Desktop Optimized")).toHaveCount(0);
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

  test("fits the captcha inside the sign-up form", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await openSignUp(page);
    const captcha = page.getByTestId("signup-captcha");
    test.skip(
      (await captcha.count()) === 0,
      "this build has no captcha site key"
    );
    // The normal widget is a fixed 300px wide; this form is narrower.
    await expect(captcha).toHaveAttribute("data-size", "compact");
    // The form animates its height after the view switch; measure once it
    // has settled.
    await expect(async () => {
      const form = await page.locator("form").boundingBox();
      const box = await captcha.boundingBox();
      expect(form).not.toBeNull();
      expect(box).not.toBeNull();
      if (!(form && box)) {
        return;
      }
      expect(box.x).toBeGreaterThanOrEqual(form.x);
      expect(box.y).toBeGreaterThanOrEqual(form.y);
      expect(box.x + box.width).toBeLessThanOrEqual(form.x + form.width);
      expect(box.y + box.height).toBeLessThanOrEqual(form.y + form.height);
    }).toPass({ timeout: 10_000 });
  });
});

test.describe("sign-in window on a short phone screen", () => {
  // An iPhone SE with Safari's toolbars showing.
  test.use({ viewport: { width: 320, height: 454 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    // Below 768px the app warns once that it is best on a larger screen.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem(
          "keeperhub-mobile-warning-dismissed",
          "true"
        );
      } catch {
        // A sandboxed frame has no storage, and no warning either.
      }
    });
  });

  test("keeps the sign-up view on screen", async ({ page }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    const dialog = page.getByRole("dialog");
    await expect(signIn.first()).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      await signIn
        .first()
        .click({ timeout: 2000 })
        .catch(() => undefined);
      await expect(dialog).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30_000 });
    await openSignUp(page);

    // The window scrolls inside itself rather than growing past the screen,
    // so its close button and Create account stay reachable.
    await expect(async () => {
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (!box) {
        return;
      }
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(454);
    }).toPass({ timeout: 10_000 });
    await expect(
      dialog.getByRole("button", { name: "Close" })
    ).toBeInViewport();
    const submit = dialog.getByRole("button", { name: "Create account" });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
  });
});
