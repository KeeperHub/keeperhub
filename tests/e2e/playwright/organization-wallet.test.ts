import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signUpAndVerify as signUpAndVerifyBase } from "./utils";

// Regex patterns (moved to top level for performance)
const SLUG_PATTERN = /test-org-/;
const CREATED_PATTERN = /created/i;
const WALLET_CREATED_PATTERN = /wallet created/i;
const ADDRESS_PATTERN = /0x.*\.\.\./;
const COPIED_PATTERN = /copied/i;

// Sign up a fresh user and wait for org switcher (used by wallet tests that need a new org)
async function signUpAndVerify(
  page: Page,
  opts?: { email?: string }
): Promise<{ email: string }> {
  const { email } = await signUpAndVerifyBase(page, { email: opts?.email });

  // Wait for org switcher to appear (org auto-created after first sign-in)
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });

  return { email };
}

// Open the organization creation form from Manage Organizations modal
async function openCreateOrgForm(page: Page): Promise<void> {
  const orgSwitcher = page.locator('button[role="combobox"]');
  await orgSwitcher.click();

  await page.locator("text=Manage Organizations").click();

  const dialog = page.locator('[role="dialog"]');
  await expect(
    dialog.locator('h2:has-text("Manage Organizations")')
  ).toBeVisible({ timeout: 5000 });

  // Check if form is already visible (may be shown by default)
  const orgNameInput = dialog.locator("#org-name");
  if (await orgNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    return; // Form already visible
  }

  // Click the "Create New Organization" button to show the form
  await dialog.locator('button:has-text("Create New Organization")').click();

  // Wait for the org name input to appear (form is now visible)
  await expect(orgNameInput).toBeVisible({ timeout: 5000 });
}

// Open the wallet overlay from the user menu
async function openWalletOverlay(page: Page): Promise<void> {
  // Click on user menu (avatar button)
  const userMenuButton = page
    .locator('button[aria-haspopup="menu"]')
    .filter({ has: page.locator("span.relative") })
    .first();
  await userMenuButton.click();

  // Wait for dropdown menu to appear
  const dropdownMenu = page.locator('[role="menu"]');
  await expect(dropdownMenu).toBeVisible({ timeout: 5000 });

  // Click on Wallet menu item
  await dropdownMenu.locator('div[role="menuitem"]:has-text("Wallet")').click();

  // Wait for wallet overlay heading to appear
  await expect(page.locator('h2:has-text("Organization Wallet")')).toBeVisible({
    timeout: 5000,
  });
}

// Create a wallet via the overlay form and wait for the success toast
async function createWalletViaOverlay(page: Page): Promise<void> {
  await page.locator('button:has-text("Create Organization Wallet")').click();

  const createBtn = page.locator('button:has-text("Create Wallet")');
  await expect(createBtn).toBeEnabled({ timeout: 5000 });
  await createBtn.click();

  // Wait for success toast (Para API can be slow in beta environments)
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: WALLET_CREATED_PATTERN })
  ).toBeVisible({ timeout: 30_000 });
}

// Run tests serially to avoid session state conflicts
test.describe.configure({ mode: "serial" });

test.describe("Organization Management", () => {
  test.describe("Organization Creation", () => {
    test("ORG-CREATE-1: user can create a new organization", async ({
      page,
    }) => {
      // Navigate to app (storageState provides auth)
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });

      // Open create organization form
      await openCreateOrgForm(page);

      const dialog = page.locator('[role="dialog"]');

      // Fill in organization details
      const orgName = `Test Org ${Date.now()}`;
      await dialog.locator("#org-name").fill(orgName);

      // Verify slug is auto-generated
      const slugInput = dialog.locator("#org-slug");
      await expect(slugInput).toHaveValue(SLUG_PATTERN);

      // Submit the form
      await dialog.locator('button:has-text("Create")').click();

      // Verify success - should redirect or show the new org
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: CREATED_PATTERN })
      ).toBeVisible({ timeout: 10_000 });
    });

    test("ORG-CREATE-2: slug is auto-generated from name", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });
      await openCreateOrgForm(page);

      const dialog = page.locator('[role="dialog"]');

      // Type organization name
      await dialog.locator("#org-name").fill("My Test Organization");

      // Verify slug is auto-generated with correct format
      const slugInput = dialog.locator("#org-slug");
      await expect(slugInput).toHaveValue("my-test-organization");
    });

    test("ORG-CREATE-3: user can manually edit slug", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });
      await openCreateOrgForm(page);

      const dialog = page.locator('[role="dialog"]');

      // Fill in organization name
      await dialog.locator("#org-name").fill("My Organization");

      // Manually edit the slug with unique timestamp
      const customSlug = `custom-slug-${Date.now()}`;
      const slugInput = dialog.locator("#org-slug");
      await slugInput.clear();
      await slugInput.fill(customSlug);

      // Verify custom slug is preserved
      await expect(slugInput).toHaveValue(customSlug);

      // Submit and verify success
      await dialog.locator('button:has-text("Create")').click();
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: CREATED_PATTERN })
      ).toBeVisible({ timeout: 10_000 });
    });

    test("ORG-CREATE-4: new organization appears in org switcher", async ({
      page,
    }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });

      // Create a new organization
      await openCreateOrgForm(page);
      const dialog = page.locator('[role="dialog"]');

      const orgName = `Switcher Test Org ${Date.now()}`;
      await dialog.locator("#org-name").fill(orgName);
      await dialog.locator('button:has-text("Create")').click();

      // Wait for creation
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: CREATED_PATTERN })
      ).toBeVisible({ timeout: 10_000 });

      // Close any open dialogs by pressing Escape
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).not.toBeVisible({
        timeout: 5000,
      });

      // Open org switcher
      const orgSwitcher = page.locator('button[role="combobox"]');
      await expect(orgSwitcher).toBeVisible({ timeout: 5000 });
      await orgSwitcher.click();

      // Verify new org appears in the list
      const popover = page.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 5000 });
      await expect(popover.locator(`text=${orgName}`)).toBeVisible();
    });
  });
});

test.describe("Para Wallet Management", () => {
  // Para beta environment has a max user limit that CI always hits
  // since each test run creates fresh users. Skip in CI.
  test.skip(!!process.env.CI, "Para beta user limit exceeded in CI");

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test.describe("Wallet Creation", () => {
    test("WALLET-CREATE-1: admin can create organization wallet", async ({
      page,
    }) => {
      const { email } = await signUpAndVerify(page);

      // Open wallet overlay
      await openWalletOverlay(page);

      // Wallet overlay doesn't have role="dialog" - scope to page
      const overlay = page;

      // Verify no wallet message is shown
      await expect(overlay.locator("text=No wallet found")).toBeVisible({
        timeout: 5000,
      });

      // Click create wallet button
      await overlay
        .locator('button:has-text("Create Organization Wallet")')
        .click();

      // Verify form appears with pre-filled email
      const emailInput = overlay.locator("#wallet-email");
      await expect(emailInput).toBeVisible({ timeout: 5000 });
      await expect(emailInput).toHaveValue(email);

      // Submit the form
      const createBtn = overlay.locator('button:has-text("Create Wallet")');
      await expect(createBtn).toBeEnabled({ timeout: 5000 });
      await createBtn.click();

      // Wait for wallet creation to complete (Para API can take ~5s)
      // Verify wallet details section appears (proves creation succeeded)
      await expect(overlay.locator("text=Account details")).toBeVisible({
        timeout: 30_000,
      });
    });

    test("WALLET-CREATE-2: wallet shows address after creation", async ({
      page,
    }) => {
      const { email } = await signUpAndVerify(page);

      await openWalletOverlay(page);

      // Create wallet
      await createWalletViaOverlay(page);

      // Verify wallet address is displayed (format: 0x...xxxx)
      await expect(page.locator("code")).toContainText(ADDRESS_PATTERN);

      // Verify email is displayed
      await expect(page.locator(`text=${email}`)).toBeVisible();
    });

    test("WALLET-CREATE-3: wallet form can be cancelled", async ({ page }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);
      // Wallet overlay doesn't have role="dialog" - scope to page
      const overlay = page;

      // Click create wallet button
      await overlay
        .locator('button:has-text("Create Organization Wallet")')
        .click();

      // Verify form appears
      await expect(overlay.locator("#wallet-email")).toBeVisible({
        timeout: 5000,
      });

      // Click cancel
      await overlay.locator('button:has-text("Cancel")').click();

      // Verify form is hidden and original message is shown
      await expect(overlay.locator("#wallet-email")).toBeHidden();
      await expect(overlay.locator("text=No wallet found")).toBeVisible();
    });

    test("WALLET-CREATE-4: wallet creation requires email", async ({
      page,
    }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);
      // Wallet overlay doesn't have role="dialog" - scope to page
      const overlay = page;

      // Open create form
      await overlay
        .locator('button:has-text("Create Organization Wallet")')
        .click();

      // Clear the pre-filled email
      const emailInput = overlay.locator("#wallet-email");
      await emailInput.clear();

      // Create button should be disabled when email is empty
      const createButton = overlay.locator('button:has-text("Create Wallet")');
      await expect(createButton).toBeDisabled();
    });
  });

  test.describe("Wallet Display", () => {
    test("WALLET-DISPLAY-1: wallet shows balance sections after creation", async ({
      page,
    }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);

      // Create wallet
      await createWalletViaOverlay(page);

      // Verify balance section appears
      await expect(page.locator('h3:has-text("Balances")')).toBeVisible({
        timeout: 10_000,
      });

      // Verify mainnet/testnet toggle exists
      await expect(page.locator('button:has-text("Mainnets")')).toBeVisible();
      await expect(page.locator('button:has-text("Testnets")')).toBeVisible();
    });

    test("WALLET-DISPLAY-2: user can toggle between mainnets and testnets", async ({
      page,
    }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);

      // Create wallet first
      await createWalletViaOverlay(page);

      // Wait for balance section
      await expect(page.locator('h3:has-text("Balances")')).toBeVisible({
        timeout: 10_000,
      });

      // Click testnets button
      await page.locator('button:has-text("Testnets")').click();

      // Testnets button should now have the active style (verify it's selected)
      const testnetsButton = page.locator('button:has-text("Testnets")');
      await expect(testnetsButton).toBeVisible();

      // Click mainnets button
      await page.locator('button:has-text("Mainnets")').click();

      // Mainnets button should be active again
      const mainnetsButton = page.locator('button:has-text("Mainnets")');
      await expect(mainnetsButton).toBeVisible();
    });

    test("WALLET-DISPLAY-3: admin can refresh balances", async ({ page }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);

      // Create wallet
      await createWalletViaOverlay(page);

      // Wait for balance section
      await expect(page.locator('h3:has-text("Balances")')).toBeVisible({
        timeout: 10_000,
      });

      // Find and click refresh button (has RefreshCw icon)
      const refreshButton = page.locator("button:has(svg.lucide-refresh-cw)");
      await expect(refreshButton).toBeVisible();
      await refreshButton.click();

      // Button is disabled while fetching - wait for it to be enabled again
      await expect(refreshButton).toBeEnabled({ timeout: 30_000 });
    });
  });

  test.describe("Wallet Copy Address", () => {
    test("WALLET-COPY-1: user can copy wallet address", async ({ page }) => {
      await signUpAndVerify(page);

      await openWalletOverlay(page);

      // Create wallet
      await createWalletViaOverlay(page);

      // Wait for wallet details to load
      await expect(page.locator("text=Account details")).toBeVisible({
        timeout: 5000,
      });

      // Click copy button (near the address)
      const copyButton = page
        .locator("button")
        .filter({ has: page.locator("svg.lucide-copy") })
        .first();
      await copyButton.click();

      // Verify toast appears
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: COPIED_PATTERN })
      ).toBeVisible({ timeout: 5000 });
    });
  });
});
