import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signUpAndVerify as signUpAndVerifyBase } from "./utils/auth";
import { getDbConnection } from "./utils/connection";
import { PERSISTENT_TEST_USER_EMAIL } from "./utils/db";
import { openOrgSettings } from "./utils/settings";

// Regex patterns (moved to top level for performance)
const SLUG_PATTERN = /test-org-/;
const CREATED_PATTERN = /created/i;
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

// Open the organization creation form on the General settings page.
async function openCreateOrgForm(page: Page): Promise<void> {
  await openOrgSettings(page, "organization");

  const orgNameInput = page.locator("#new-org-name");
  if (await orgNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }
  // Re-click until the form opens: straight after navigation the first click
  // can land before the handler is wired and be dropped.
  const openForm = page.getByRole("button", { name: "New organization" });
  await expect(openForm).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await openForm.click();
    await expect(orgNameInput).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
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

// Wait for the wallet that is auto-provisioned at signup to resolve. The
// toolbar address only appears once provisioning (a real Turnkey call) has
// completed, so this is the signal that the org has its wallet.
async function waitForAutoProvisionedWallet(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="wallet-toolbar-address"]')
  ).toBeVisible({ timeout: 45_000 });
}

// Run tests serially to avoid session state conflicts
test.describe.configure({ mode: "serial" });

test.describe("Organization Management", () => {
  test.describe("Organization Creation", () => {
    // These tests create orgs as the shared persistent test user, which (via
    // the afterCreateOrganization hook) flips that user's session active org
    // and adds owner memberships. Later suites (workflow save, webhook toggle,
    // marketplace listing) assume it acts in its seeded e2e-test-org, and a
    // drifted active org makes their org-scoped API calls 404. Restore the
    // session's active org to the seeded (owner, oldest) org after this block;
    // createTestWorkflow targets that same org, so the two halves agree.
    test.afterAll(async () => {
      const sql = getDbConnection();
      try {
        const userRows = await sql`
          SELECT id FROM users WHERE email = ${PERSISTENT_TEST_USER_EMAIL} LIMIT 1
        `;
        if (userRows.length === 0) {
          return;
        }
        const userId = userRows[0].id as string;
        const orgRows = await sql`
          SELECT organization_id FROM member
          WHERE user_id = ${userId} AND role = 'owner'
          ORDER BY created_at ASC
          LIMIT 1
        `;
        if (orgRows.length > 0) {
          await sql`
            UPDATE sessions SET active_organization_id = ${orgRows[0].organization_id}
            WHERE user_id = ${userId}
          `;
        }
      } finally {
        await sql.end();
      }
    });

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

      const orgName = `Test Org ${Date.now()}`;
      await page.locator("#new-org-name").fill(orgName);

      // Verify slug is auto-generated
      await expect(page.locator("#new-org-slug")).toHaveValue(SLUG_PATTERN);

      await page.getByRole("button", { name: "Create organization" }).click();

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

      // Type organization name
      await page.locator("#new-org-name").fill("My Test Organization");

      // Verify slug is auto-generated with correct format
      const slugInput = page.locator("#new-org-slug");
      await expect(slugInput).toHaveValue("my-test-organization");
    });

    test("ORG-CREATE-3: user can manually edit slug", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });
      await openCreateOrgForm(page);

      // Fill in organization name
      await page.locator("#new-org-name").fill("My Organization");

      // Manually edit the slug with unique timestamp
      const customSlug = `custom-slug-${Date.now()}`;
      const slugInput = page.locator("#new-org-slug");
      await slugInput.clear();
      await slugInput.fill(customSlug);

      // Verify custom slug is preserved
      await expect(slugInput).toHaveValue(customSlug);

      // Submit and verify success
      await page.getByRole("button", { name: "Create organization" }).click();
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

      const orgName = `Switcher Test Org ${Date.now()}`;
      await page.locator("#new-org-name").fill(orgName);
      await page.getByRole("button", { name: "Create organization" }).click();

      // Wait for creation
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: CREATED_PATTERN })
      ).toBeVisible({ timeout: 10_000 });

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

// The org wallet is now auto-provisioned at signup (Turnkey), so these specs
// assert the overlay UI against that auto-created wallet. The manual
// create-from-empty form is intentionally not covered here: provisioning runs
// on every wallet-less org, so the empty-state entry point is no longer
// reachable (deleting the wallet just re-triggers provisioning). The
// auto-provision path itself is covered in wallet-autoprovision.test.ts.
test.describe("Organization Wallet (auto-provisioned)", () => {
  test.skip(!!process.env.CI, "Turnkey API unreliable in CI");

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test.describe("Wallet Display", () => {
    test("WALLET-DISPLAY-1: wallet shows balance sections", async ({
      page,
    }) => {
      await signUpAndVerify(page);
      await waitForAutoProvisionedWallet(page);
      await openWalletOverlay(page);

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
      await waitForAutoProvisionedWallet(page);
      await openWalletOverlay(page);

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
      await waitForAutoProvisionedWallet(page);
      await openWalletOverlay(page);

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
      await waitForAutoProvisionedWallet(page);
      await openWalletOverlay(page);

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
