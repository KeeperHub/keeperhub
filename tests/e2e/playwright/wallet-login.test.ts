import { expect, test } from "./fixtures";
import { getDbConnection } from "./utils/connection";
import { installWalletStub, TEST_WALLET_ADDRESS } from "./utils/wallet-stub";

// SIWE wallet login via the welcome page, exercised with the injected-wallet
// stub (EIP-6963 + personal_sign signed by a throwaway key). Runs logged-out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("wallet login (SIWE)", () => {
  test.beforeEach(async ({ page }) => {
    // The test wallet is shared across specs; another spec (wallet org-MFA) may
    // have marked it onboarded. Reset so this always exercises the new-wallet
    // path -- a fresh SIWE user has onboarding_completed=false and is routed
    // into the wizard.
    const sql = getDbConnection();
    try {
      await sql`
        update users set onboarding_completed = false
        from wallet_address w
        where users.id = w.user_id
          and lower(w.address) = ${TEST_WALLET_ADDRESS.toLowerCase()}`;
    } finally {
      await sql.end();
    }
    await installWalletStub(page);
  });

  test("connects, mints a session, and enters onboarding", async ({ page }) => {
    await page.goto("/welcome", { waitUntil: "domcontentloaded" });

    // Reveal the wallet picker and pick the injected wallet.
    await page.getByRole("button", { name: "Wallet" }).click();
    const walletButton = page.getByTestId("connect-wallet-io.metamask");
    await expect(walletButton).toBeVisible({ timeout: 15_000 });
    await walletButton.click();

    // Signed in: a new wallet account lands on the onboarding wizard, keeping
    // its server-generated handle (no display-name prompt, no 0x address).
    await expect(
      page.getByRole("heading", { name: "Name your organization" })
    ).toBeVisible({ timeout: 20_000 });
  });
});
