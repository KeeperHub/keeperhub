import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signUpAndVerify } from "./utils/auth";

const ADDRESS_PATTERN = /0x.*\.\.\./;

// Turnkey is the real external wallet provider and, like the manual-wallet
// specs, is unreliable in CI - so this auto-provisioning suite runs locally
// only (needs a dev server with Turnkey creds at http://localhost:3000).
test.describe.configure({ mode: "serial" });

// Open the organization wallet overlay from the user menu.
async function openWalletOverlay(page: Page): Promise<void> {
  const userMenuButton = page
    .locator('button[aria-haspopup="menu"]')
    .filter({ has: page.locator("span.relative") })
    .first();
  await userMenuButton.click();

  const dropdownMenu = page.locator('[role="menu"]');
  await expect(dropdownMenu).toBeVisible({ timeout: 5000 });
  await dropdownMenu.locator('div[role="menuitem"]:has-text("Wallet")').click();

  await expect(page.locator('h2:has-text("Organization Wallet")')).toBeVisible({
    timeout: 5000,
  });
}

test.describe("Wallet auto-provisioning at signup", () => {
  test.skip(!!process.env.CI, "Turnkey API unreliable in CI");

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("AUTOPROV-1: signup provisions a wallet with no manual action", async ({
    page,
  }) => {
    // Completing signup (org auto-created, switcher visible) also confirms the
    // removed signup-time eager hook did not break the auth flow.
    await signUpAndVerify(page);

    // The workflow page hosts the wallet toolbar affordance.
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const address = page.locator('[data-testid="wallet-toolbar-address"]');

    // The toolbar resolves to a real address on its own - no wallet overlay
    // opened and no "Create wallet" click - proving signup auto-provisioned it.
    await expect(address).toBeVisible({ timeout: 45_000 });
    await expect(address).toContainText("0x");
  });

  test("AUTOPROV-2: auto-provisioned wallet appears in the wallet overlay", async ({
    page,
  }) => {
    const { email } = await signUpAndVerify(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the auto-provisioned wallet to resolve in the toolbar first.
    await expect(
      page.locator('[data-testid="wallet-toolbar-address"]')
    ).toBeVisible({ timeout: 45_000 });

    await openWalletOverlay(page);

    // The overlay reflects the same wallet (address + the signup email it was
    // derived from), created without the manual overlay form.
    await expect(page.locator("text=Account details")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("code")).toContainText(ADDRESS_PATTERN);
    await expect(page.locator(`text=${email}`)).toBeVisible();
  });
});
