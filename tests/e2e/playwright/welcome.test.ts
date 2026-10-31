import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { enterAsGuest, openSignupView } from "./utils/auth";

// Logged-out visitors are routed to the welcome landing; the guest link drops
// them into the app without an account. Runs with a fresh anonymous context.
test.use({ storageState: { cookies: [], origins: [] } });

const WELCOME_ROOT = /\/welcome$/;
const WELCOME_ANY = /\/welcome/;
// Production builds prefix the session cookie with `__Secure-` (useSecureCookies).
const SESSION_COOKIE_NAME_RE = /^(?:__Secure-)?better-auth\.session_token$/;
const CLIENT_ERROR_REGEX = /Application error/;
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
    await openSignupView(page);
    await expect(page.getByText(CLIENT_ERROR_REGEX)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Sign in to KeeperHub" })
    ).toBeVisible();
  });

  test("guest link mints an anonymous session and lands on the app", async ({
    page,
    context,
  }) => {
    await enterAsGuest(page);

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

  test("fits the captcha inside the sign-up form", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    await openSignupView(page);
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

// A phone turned sideways, and an iPhone SE with Safari's toolbars showing:
// screens shorter than the sign-in card or window.
const SIDEWAYS = { name: "a phone turned sideways", width: 667, height: 375 };
const SHORT_SCREENS = [
  { name: "an iPhone SE with Safari's toolbars", width: 320, height: 454 },
  SIDEWAYS,
];

test.describe("welcome landing on a phone turned sideways", () => {
  test.use({
    viewport: { width: SIDEWAYS.width, height: SIDEWAYS.height },
    hasTouch: true,
  });

  test("opens sign-up with its heading in sight", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });
    // Create an account sits below the fold here, so reaching it scrolls the
    // page down past the top of the card.
    const createAccount = page.getByRole("button", {
      name: "Create an account",
    });
    await expect(createAccount).toBeVisible({ timeout: 15_000 });
    await expect(createAccount).not.toBeInViewport();
    await openSignupView(page);
    await expect(
      page.getByRole("heading", { name: "Create your account" })
    ).toBeInViewport({ ratio: 1 });
  });
});

// Opens the Sign in window from the app header on /hub.
async function openSignInWindow(page: Page): Promise<Locator> {
  await page.goto("/hub", { waitUntil: "domcontentloaded" });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await signIn.click({ timeout: 2000 }).catch(() => undefined);
    await expect(dialog).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

// Scrolls the sign-in choices inside the window with the mouse wheel, the way
// a visitor scrolls rather than by script, from the area's top corner (a
// wheel over the captcha's frame would scroll the frame instead). Retried
// while the window may still be growing as the captcha arrives.
async function scrollChoicesDown(
  page: Page,
  choices: Locator,
  until: () => Promise<void>
): Promise<void> {
  await expect(async () => {
    await choices.hover({ position: { x: 2, y: 2 } });
    await page.mouse.wheel(0, 2000);
    await until();
  }).toPass({ timeout: 15_000 });
}

function scrollTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.scrollTop);
}

for (const screen of SHORT_SCREENS) {
  test.describe(`sign-in window on ${screen.name}`, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: true,
    });

    test("stays on screen and scrolls inside", async ({ page }) => {
      const dialog = await openSignInWindow(page);
      const choices = dialog.getByTestId("auth-dialog-choices");
      const close = dialog.getByRole("button", { name: "Close" });
      await openSignupView(page);

      // Taller than the screen, so it scrolls inside itself rather than run
      // off the top and bottom.
      await expect(async () => {
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        if (!box) {
          return;
        }
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(screen.height);
      }).toPass({ timeout: 10_000 });

      // Reaching Create an account scrolled the choices down; the sign-up
      // view starts back at the top.
      await expect(
        dialog.getByRole("heading", { name: "Create your account" })
      ).toBeInViewport({ ratio: 1 });

      // Scrolled down to Create account, the title and the close button
      // stay where they were.
      const submit = dialog.getByRole("button", { name: "Create account" });
      await scrollChoicesDown(page, choices, async () => {
        await expect(submit).toBeInViewport({ timeout: 1000 });
      });
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(
        dialog.getByRole("heading", { name: "Sign in to KeeperHub" })
      ).toBeInViewport({ ratio: 1 });
    });

    test("opens and leaves the wallet picker at the top", async ({ page }) => {
      const dialog = await openSignInWindow(page);
      const choices = dialog.getByTestId("auth-dialog-choices");

      // Scrolled down first, as a visitor who read the whole window would be.
      await scrollChoicesDown(page, choices, async () => {
        expect(await scrollTop(choices)).toBeGreaterThan(0);
      });
      await dialog.getByRole("button", { name: "Wallet", exact: true }).click();
      await expect(
        page.getByText("Nothing leaves your device but a signature.")
      ).toBeVisible();
      await expect.poll(() => scrollTop(choices)).toBe(0);

      // At the bottom of the picker, so reaching it scrolls the choices down.
      await dialog
        .getByRole("button", { name: "Other ways to sign in" })
        .click();
      await expect(dialog.locator("#auth-email")).toBeVisible();
      await expect.poll(() => scrollTop(choices)).toBe(0);
    });
  });
}
