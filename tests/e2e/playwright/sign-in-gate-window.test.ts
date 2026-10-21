import type { Browser, BrowserContext, Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { fillContentEditableOtp, signUpAndVerify } from "./utils/auth";
import { getDbConnection } from "./utils/connection";
import { box } from "./utils/layout";

// The window /verify-mfa shows (and /verify-ip, which renders the same
// SignInGateDialog). On phones and touch screens it sits near the top so the
// on-screen keyboard does not cover the code field and the buttons; a desktop
// with a mouse keeps the centred window.
test.use({ storageState: { cookies: [], origins: [] } });

// A phone's number pad with its autofill bar is about 260-300px tall.
const KEYBOARD_HEIGHT = 300;

type Screen = { name: string; width: number; height: number; touch: boolean };

const PHONE: Screen = { name: "phone", width: 390, height: 844, touch: true };
// The window's steps overflow this screen by about 20px, so the scroll
// check below has room before a copy change makes them fit.
const SIDEWAYS: Screen = {
  name: "phone turned sideways",
  width: 667,
  height: 375,
  touch: true,
};
const TABLET: Screen = {
  name: "tablet",
  width: 820,
  height: 1180,
  touch: true,
};
const DESKTOP: Screen = {
  name: "desktop",
  width: 1280,
  height: 720,
  touch: false,
};

// The state a fresh sign-in of a two-factor user leaves its session in: the
// app sends it to /verify-mfa until both codes are entered.
async function requireMfaStepUp(email: string): Promise<void> {
  const sql = getDbConnection();
  try {
    await sql`
      update sessions set requires_mfa = true
      where user_id = (select id from users where email = ${email})`;
  } finally {
    await sql.end();
  }
}

async function openGate(
  browser: Browser,
  signedIn: BrowserContext,
  screen: Screen
): Promise<{ context: BrowserContext; dialog: Locator }> {
  const context = await browser.newContext({
    storageState: await signedIn.storageState(),
    viewport: { width: screen.width, height: screen.height },
    hasTouch: screen.touch,
  });
  const page = await context.newPage();
  await page.goto("/verify-mfa", { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // Wait out the opening zoom before measuring.
  await expect(async () => {
    const first = await box(dialog);
    await page.waitForTimeout(100);
    expect(await box(dialog)).toEqual(first);
  }).toPass({ timeout: 5000 });
  return { context, dialog };
}

test.describe("sign-in check window", () => {
  test("sits above the keyboard on touch screens and stays centred on desktop", async ({
    browser,
    page,
  }) => {
    // A full sign-up plus four screens runs close to the default 60s.
    test.slow();
    const { email } = await signUpAndVerify(page);
    await requireMfaStepUp(email);

    await test.step(PHONE.name, async () => {
      const { context, dialog } = await openGate(
        browser,
        page.context(),
        PHONE
      );
      expect((await box(dialog)).y).toBeCloseTo(16, 0);
      const continueButton = dialog.getByRole("button", { name: "Continue" });
      const button = await box(continueButton);
      expect(button.y + button.height).toBeLessThanOrEqual(
        PHONE.height - KEYBOARD_HEIGHT
      );

      // Each step's field gets the cursor, so the keyboard can stay open.
      await fillContentEditableOtp(
        dialog.locator("#dfs-email-verify"),
        "123456"
      );
      await continueButton.tap();
      await expect(dialog.locator("#dfs-totp")).toBeFocused();
      await dialog.getByRole("button", { name: "Back" }).tap();
      await expect(dialog.locator("#dfs-email-verify")).toBeFocused();
      await context.close();
    });

    await test.step(SIDEWAYS.name, async () => {
      const { context, dialog } = await openGate(
        browser,
        page.context(),
        SIDEWAYS
      );
      const frame = await box(dialog);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.y + frame.height).toBeLessThanOrEqual(SIDEWAYS.height);

      // Too tall for the screen: the steps scroll, the title stays.
      const body = dialog.getByTestId("sign-in-gate-body");
      const scrolled = await body.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        return node.scrollTop;
      });
      expect(scrolled).toBeGreaterThan(0);
      await expect(
        dialog.getByRole("heading", { name: "Confirm it's you" })
      ).toBeInViewport({ ratio: 1 });
      await expect(
        dialog.getByRole("button", { name: "Continue" })
      ).toBeInViewport({ ratio: 1 });
      await context.close();
    });

    await test.step(TABLET.name, async () => {
      const { context, dialog } = await openGate(
        browser,
        page.context(),
        TABLET
      );
      expect(
        Math.abs((await box(dialog)).y - TABLET.height * 0.12)
      ).toBeLessThan(1);
      await context.close();
    });

    await test.step(DESKTOP.name, async () => {
      const { context, dialog } = await openGate(
        browser,
        page.context(),
        DESKTOP
      );
      const frame = await box(dialog);
      expect(
        Math.abs(frame.y + frame.height / 2 - DESKTOP.height / 2)
      ).toBeLessThanOrEqual(1);
      // sm:max-w-md, the width the window always had on desktop.
      expect(frame.width).toBe(448);
      await context.close();
    });
  });
});
