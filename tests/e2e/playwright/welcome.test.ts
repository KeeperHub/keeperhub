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

// Takes the guest link into the app.
async function continueAsGuest(page: Page): Promise<void> {
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
    await continueAsGuest(page);

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
    const options = page.getByRole("button", { name: SOCIAL_OPTION_REGEX });
    test.skip(
      (await options.count()) < 2,
      "this build has no Google or GitHub sign-in"
    );
    const tops = await options.evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top))
    );
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
    await continueAsGuest(page);
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

const SHORT_SCREENS = [
  { name: "an iPhone SE with Safari's toolbars", width: 320, height: 454 },
  { name: "a phone turned sideways", width: 667, height: 375 },
];

for (const screen of SHORT_SCREENS) {
  test.describe(`sign-in window on ${screen.name}`, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: true,
    });

    test("stays on screen and scrolls inside", async ({ page }) => {
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      // Below 768px the app first warns that it is best on a larger screen.
      await page.getByRole("button", { name: "Continue Anyway" }).click();
      const signIn = page.getByRole("button", { name: "Sign in", exact: true });
      const dialog = page.getByRole("dialog");
      await expect(async () => {
        await signIn.click({ timeout: 2000 }).catch(() => undefined);
        await expect(dialog).toBeVisible({ timeout: 4000 });
      }).toPass({ timeout: 30_000 });
      await openSignUp(page);

      // Taller than the screen, so it has to scroll inside itself rather
      // than run off the top and bottom.
      await expect(async () => {
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        if (!box) {
          return;
        }
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(screen.height);
      }).toPass({ timeout: 10_000 });
      expect(
        await dialog.evaluate((d) => d.scrollHeight > d.clientHeight)
      ).toBe(true);

      // Reaching Create an account scrolled the window down; the sign-up view
      // starts back at the top, close button in sight.
      await expect(
        dialog.getByRole("button", { name: "Close" })
      ).toBeInViewport();
      // Scrolled the way a visitor scrolls, not by script, from the title: a
      // wheel over the captcha's frame would scroll the frame instead. The
      // window is still growing as the captcha arrives, so keep scrolling
      // until the button shows, as a visitor would.
      const title = dialog.getByRole("heading", {
        name: "Sign in to KeeperHub",
      });
      const submit = dialog.getByRole("button", { name: "Create account" });
      await expect(async () => {
        await title.hover();
        await page.mouse.wheel(0, 2000);
        await expect(submit).toBeInViewport({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
    });
  });
}
