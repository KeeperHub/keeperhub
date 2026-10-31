import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
} from "@playwright/test";
import {
  encodePendingIpCookie,
  pendingIpCookieName,
} from "@/lib/pending-ip-cookie";
import { expect, test } from "./fixtures";
import { fillContentEditableOtp, signUpAndVerify } from "./utils/auth";
import { getDbConnection } from "./utils/connection";
import { getUserIdByEmail, getUserOrganizationId } from "./utils/db";
import { box, dismissPhoneOverlays } from "./utils/layout";

// Every window that holds the two-step code entry: the locked windows of
// /verify-mfa and /verify-ip, a settings dialog and an overlay. On phones and
// touch screens it sits near the top, above the on-screen keyboard, and never
// grows past what the keyboard leaves visible; a desktop with a mouse keeps
// the centred window; a window that does not fit scrolls.
test.use({ storageState: { cookies: [], origins: [] } });

// A phone's number pad with its autofill bar is about 260-300px tall.
const KEYBOARD_HEIGHT = 300;

type Screen = {
  name: string;
  width: number;
  height: number;
  touch: boolean;
  // Height left above an open on-screen keyboard, when one is open.
  visibleHeight?: number;
};

const PHONE: Screen = { name: "phone", width: 390, height: 844, touch: true };
const SHORT_PHONE_KEYBOARD: Screen = {
  name: "short phone with the keyboard open",
  width: 375,
  height: 667,
  touch: true,
  visibleHeight: 667 - KEYBOARD_HEIGHT,
};
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
// Short enough that both gate windows overflow, so the title check bites.
const SHORT_DESKTOP: Screen = {
  name: "short desktop window",
  width: 1280,
  height: 340,
  touch: false,
};

type Gate = { path: string; title: string };
const VERIFY_MFA: Gate = { path: "/verify-mfa", title: "Confirm it's you" };
const VERIFY_IP: Gate = {
  path: "/verify-ip",
  title: "Confirm this new sign-in",
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

// The signed cookie a sign-in from a new network leaves instead of a session;
// /verify-ip renders its window from it.
async function pendingIpCookie(
  email: string,
  baseURL: string
): Promise<BrowserContextOptions["storageState"]> {
  const secret = process.env.BETTER_AUTH_SECRET;
  const userId = await getUserIdByEmail(email);
  if (!(secret && userId)) {
    throw new Error("BETTER_AUTH_SECRET and a signed-up user are required");
  }
  const value = encodePendingIpCookie(
    { userId, email, ip: "203.0.113.7", country: "RO", redirect: "/" },
    secret
  );
  const { hostname } = new URL(baseURL);
  return {
    cookies: [
      {
        name: pendingIpCookieName(),
        value,
        domain: hostname,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

// Every context a step opens, so one left open by a failing step is closed
// after the test.
const openContexts = new Set<BrowserContext>();

test.afterEach(async () => {
  await Promise.allSettled([...openContexts].map((context) => context.close()));
});

async function newScreenContext(
  browser: Browser,
  storageState: BrowserContextOptions["storageState"],
  screen: Screen
): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState,
    viewport: { width: screen.width, height: screen.height },
    hasTouch: screen.touch,
  });
  openContexts.add(context);
  context.on("close", () => openContexts.delete(context));
  return context;
}

async function openGate(
  browser: Browser,
  storageState: BrowserContextOptions["storageState"],
  gate: Gate,
  screen: Screen
): Promise<{ context: BrowserContext; dialog: Locator }> {
  const context = await newScreenContext(browser, storageState, screen);
  if (screen.visibleHeight !== undefined) {
    // An open keyboard shrinks the visual viewport, not the layout viewport.
    await context.addInitScript((height) => {
      const viewport = window.visualViewport;
      if (viewport) {
        Object.defineProperty(viewport, "height", { get: () => height });
      }
    }, screen.visibleHeight);
  }
  const page = await context.newPage();
  await page.goto(gate.path, { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: gate.title });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await waitUntilStill(page, dialog);
  return { context, dialog };
}

// Waits out a window's opening zoom or move before measuring it.
async function waitUntilStill(page: Page, locator: Locator): Promise<void> {
  await expect(async () => {
    const first = await box(locator);
    await page.waitForTimeout(100);
    expect(await box(locator)).toEqual(first);
  }).toPass({ timeout: 5000 });
}

// An overlay holding the code entry (creating an API key) moves up on a touch
// tablet once the code step shows, and stays centred with a mouse. Below 768px
// overlays are a vaul drawer, which follows the visual viewport itself.
async function checkOverlayCodeEntry(
  browser: Browser,
  storageState: BrowserContextOptions["storageState"],
  orgId: string
): Promise<void> {
  for (const screen of [TABLET, DESKTOP]) {
    const context = await newScreenContext(browser, storageState, screen);
    const page = await context.newPage();
    await page.goto(`/settings/${orgId}/api-keys`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "New key" }).first().click();
    const card = page.getByTestId("overlay-window");
    await card.locator("#key-name").fill("keyboard-safe check");
    await card.getByRole("button", { name: "Continue" }).click();
    const field = card.locator("#dfs-email-verify");
    await expect(field).toBeVisible();
    await waitUntilStill(page, card);
    const frame = await box(card);
    if (screen.touch) {
      // The overlay's positioned container, 12% from the top.
      expect(Math.abs(frame.y - screen.height * 0.12)).toBeLessThanOrEqual(1);
    } else {
      expect(
        Math.abs(frame.y + frame.height / 2 - screen.height / 2)
      ).toBeLessThanOrEqual(1);
    }
    await context.close();
  }
}

// Every window that hosts the code entry gets the same placement, not only
// the sign-in gates: here the account deactivation dialog in settings.
async function checkSettingsCodeEntry(
  browser: Browser,
  storageState: BrowserContextOptions["storageState"]
): Promise<void> {
  const context = await newScreenContext(browser, storageState, PHONE);
  const page = await context.newPage();
  await dismissPhoneOverlays(page);
  await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Deactivate Account" }).tap();
  const dialog = page.getByRole("alertdialog", {
    name: "Deactivate your account?",
  });
  await dialog.locator("#deactivateConfirmation").fill("DEACTIVATE");
  await dialog.getByRole("button", { name: "Continue" }).tap();
  await expect(dialog.locator("#dfs-email-verify")).toBeVisible();
  await waitUntilStill(page, dialog);

  expect((await box(dialog)).y).toBeCloseTo(16, 0);
  const button = await box(dialog.getByRole("button", { name: "Continue" }));
  expect(button.y + button.height).toBeLessThanOrEqual(
    PHONE.height - KEYBOARD_HEIGHT
  );
  await context.close();
}

// The window fits the visible height, and scrolling it (on phones and touch
// screens the whole window scrolls; with a mouse its content below the title
// does, and the title stays) brings Continue into view, whatever the copy
// length.
async function expectFitsAndScrolls(
  dialog: Locator,
  gate: Gate,
  screen: Screen
): Promise<void> {
  const visibleHeight = screen.visibleHeight ?? screen.height;
  const frame = await box(dialog);
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(visibleHeight);

  const heading = dialog.getByRole("heading", { name: gate.title });
  const headingBefore = await box(heading);
  const body = dialog.getByTestId("sign-in-gate-body");
  let bodyOverflows = false;
  for (const scroller of [dialog, body]) {
    const { overflows, scrollTop } = await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return {
        overflows: node.scrollHeight > node.clientHeight,
        scrollTop: node.scrollTop,
      };
    });
    if (overflows) {
      expect(scrollTop).toBeGreaterThan(0);
    }
    if (scroller === body) {
      bodyOverflows = overflows;
    }
  }
  const button = await box(dialog.getByRole("button", { name: "Continue" }));
  expect(button.y).toBeGreaterThanOrEqual(frame.y);
  expect(button.y + button.height).toBeLessThanOrEqual(frame.y + frame.height);
  expect(button.y + button.height).toBeLessThanOrEqual(visibleHeight);
  if (!screen.touch) {
    // With a mouse only the content below the title scrolls. The screen is
    // chosen so it has to scroll; if a copy change makes it fit, pick a
    // shorter one rather than let the title check pass without testing.
    expect(bodyOverflows).toBe(true);
    expect((await box(heading)).y).toBeCloseTo(headingBefore.y, 0);
  }
}

async function checkGate(
  browser: Browser,
  storageState: BrowserContextOptions["storageState"],
  gate: Gate
): Promise<void> {
  await test.step(`${gate.path} on a ${PHONE.name}`, async () => {
    const { context, dialog } = await openGate(
      browser,
      storageState,
      gate,
      PHONE
    );
    expect((await box(dialog)).y).toBeCloseTo(16, 0);
    const continueButton = dialog.getByRole("button", { name: "Continue" });
    const button = await box(continueButton);
    expect(button.y + button.height).toBeLessThanOrEqual(
      PHONE.height - KEYBOARD_HEIGHT
    );

    // Each step's field gets the cursor, so the keyboard can stay open.
    await fillContentEditableOtp(dialog.locator("#dfs-email-verify"), "123456");
    await continueButton.tap();
    await expect(dialog.locator("#dfs-totp")).toBeFocused();
    await dialog.getByRole("button", { name: "Back" }).tap();
    await expect(dialog.locator("#dfs-email-verify")).toBeFocused();
    await context.close();
  });

  for (const screen of [SHORT_PHONE_KEYBOARD, SIDEWAYS, SHORT_DESKTOP]) {
    await test.step(`${gate.path} on a ${screen.name}`, async () => {
      const { context, dialog } = await openGate(
        browser,
        storageState,
        gate,
        screen
      );
      await expectFitsAndScrolls(dialog, gate, screen);
      await context.close();
    });
  }

  await test.step(`${gate.path} on a ${TABLET.name}`, async () => {
    const { context, dialog } = await openGate(
      browser,
      storageState,
      gate,
      TABLET
    );
    expect(
      Math.abs((await box(dialog)).y - TABLET.height * 0.12)
    ).toBeLessThanOrEqual(1);
    await context.close();
  });

  await test.step(`${gate.path} on a ${DESKTOP.name}`, async () => {
    const { context, dialog } = await openGate(
      browser,
      storageState,
      gate,
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
}

test.describe("keyboard-safe window", () => {
  test("sits above the keyboard on touch screens and stays reachable everywhere", async ({
    baseURL,
    browser,
    page,
  }) => {
    // A full sign-up plus both pages at six sizes runs well past 60s.
    test.slow();
    const { email, totpKey } = await signUpAndVerify(page);
    // A real step-up: the user enrolled TOTP during sign-up.
    expect(totpKey).not.toBe("");

    await test.step("a settings code entry on a phone", async () => {
      await checkSettingsCodeEntry(
        browser,
        await page.context().storageState()
      );
    });

    await test.step("an overlay code entry on a tablet and a desktop", async () => {
      const userId = await getUserIdByEmail(email);
      const orgId = userId && (await getUserOrganizationId(userId));
      if (!orgId) {
        throw new Error("the signed-up user has no organization");
      }
      await checkOverlayCodeEntry(
        browser,
        await page.context().storageState(),
        orgId
      );
    });

    await requireMfaStepUp(email);
    await checkGate(browser, await page.context().storageState(), VERIFY_MFA);

    if (!baseURL) {
      throw new Error("baseURL is required");
    }
    await checkGate(browser, await pendingIpCookie(email, baseURL), VERIFY_IP);
  });
});
