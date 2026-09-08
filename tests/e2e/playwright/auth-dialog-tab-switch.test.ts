import { expect, test } from "./fixtures";

// Unique per run: the reset request allows only 5 per address per 15 minutes,
// so a constant address throttles on repeated runs.
const uniqueEmail = (): string => `tab-switch+${Date.now()}@techops.services`;

/**
 * The in-app sign-in dialog must survive a tab switch. Better Auth refetches the
 * session on tab focus and UserMenu drops to a skeleton while that is pending,
 * which unmounts ConnectButton and the dialog state it owns. Users leave the tab
 * to copy an emailed code, so losing the dialog there strands them mid-flow.
 */
test.describe("auth dialog lifecycle", () => {
  test("survives a tab switch while awaiting an emailed reset code", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    const dialog = await openSignInDialog(page);

    // The request leg answers success for unknown emails so it cannot be used to
    // enumerate accounts, so the reset view is reachable without a real user.
    await dialog.locator("#auth-email").fill(uniqueEmail());
    await dialog.getByRole("button", { name: "Forgot password?" }).click();
    await dialog.getByRole("button", { name: "Send reset code" }).click();

    const resetHeading = dialog.getByRole("heading", {
      name: "Enter your reset code",
    });
    await expect(resetHeading).toBeVisible({ timeout: 20_000 });

    await switchAwayAndBack(page);

    await expect(resetHeading).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByPlaceholder("Reset code")).toBeVisible();
  });

  test("keeps a typed email across a tab switch on the sign-in view", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    const dialog = await openSignInDialog(page);
    const typed = uniqueEmail();
    await dialog.locator("#auth-email").fill(typed);

    await switchAwayAndBack(page);

    await expect(dialog.locator("#auth-email")).toBeVisible({
      timeout: 20_000,
    });
    await expect(dialog.locator("#auth-email")).toHaveValue(typed);
  });
});

/**
 * A real tab switch, which is what Better Auth's focus manager listens for.
 * bringToFront does not change visibilityState in headless Chromium, so it
 * would not exercise this path.
 */
async function switchAwayAndBack(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/**
 * Open the in-app sign-in dialog as a visitor with no session at all. Guests
 * hold an anonymous session, which UserMenu already exempts from the skeleton,
 * so the teardown only reproduces here. /hub is public; "/" would redirect to
 * /welcome, where the panel renders inline and is never unmounted.
 */
async function openSignInDialog(
  page: import("@playwright/test").Page
): Promise<import("@playwright/test").Locator> {
  await page.goto("/hub", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog.locator("#auth-email")).toBeVisible({ timeout: 20_000 });
  return dialog;
}
