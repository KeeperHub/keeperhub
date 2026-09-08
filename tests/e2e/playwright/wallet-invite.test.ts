import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures";
import { getDbConnection } from "./utils/connection";
import {
  getInvitationIdFromDb,
  gotoAcceptInvite,
  openInviteForm,
} from "./utils/invitations";
import { stubTurnstile } from "./utils/turnstile";
import {
  completeWalletLogin,
  installWalletStub,
  TEST_WALLET_ADDRESS,
} from "./utils/wallet-stub";

// Inviting a wallet (SIWE) user to an org by their sign-in address, then the
// wallet user accepting via the sign-to-join challenge. Owner is the persistent
// test user (default storageState); the wallet user runs in a second context.

const INVITE_CREATED_REGEX = /invitation created/i;
const WELCOME_REGEX = /welcome to/i;
const SIGN_TO_JOIN_REGEX = /sign to join/i;
const NOT_FOUND_REGEX = /no keeperhub account signs in with that wallet/i;
const ADDRESS_INPUT = "0x...";

// The owner invited by address, which resolved to the wallet account's
// synthetic email; look that email up to find the pending invitation id.
async function walletInviteId(): Promise<string> {
  const sql = getDbConnection();
  let email: string;
  try {
    const rows = await sql`
      select u.email from users u
      join wallet_address w on w.user_id = u.id
      where lower(w.address) = ${TEST_WALLET_ADDRESS.toLowerCase()}
      limit 1`;
    const emailValue = rows[0]?.email;
    if (!emailValue) {
      throw new Error(
        `No wallet_address row found for ${TEST_WALLET_ADDRESS} — has the wallet user signed in yet?`
      );
    }
    email = emailValue;
  } finally {
    await sql.end();
  }
  return getInvitationIdFromDb(email);
}

// A bare browser context doesn't inherit the project's bypass headers or the
// tour-disable cookie, so a wallet sign-in there would stall. Replicate both.
async function newBypassContext(
  browser: import("@playwright/test").Browser
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    // Force a logged-out context; otherwise it inherits the project storageState
    // (the owner session) and there is no Connect button to sign in with.
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: {
      "X-Test-API-Key": process.env.TEST_API_KEY ?? "",
      "x-load-test-mfa-bypass": process.env.LOAD_TEST_BYPASS_TOKEN ?? "",
    },
  });
  await ctx.addCookies([
    { name: "kh_disable_tours", value: "1", url: "http://localhost:3000" },
  ]);
  return ctx;
}

test.describe("wallet org invite", () => {
  test("owner invites by address, wallet user signs to join", async ({
    page,
    browser,
  }) => {
    // 1. The wallet user signs in once so the account + wallet_address row
    //    exist for the owner's address lookup.
    const walletCtx = await newBypassContext(browser);
    try {
      const walletPage = await walletCtx.newPage();
      await stubTurnstile(walletPage);
      await installWalletStub(walletPage);
      await completeWalletLogin(walletPage);

      // 2. Owner invites that sign-in address.
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await openInviteForm(page);
      await page
        .getByRole("button", { name: "Invite by wallet address instead" })
        .click();
      await page.getByPlaceholder(ADDRESS_INPUT).fill(TEST_WALLET_ADDRESS);
      await page.getByRole("button", { name: "Create invite link" }).click();
      await expect(page.locator("[data-sonner-toast]")).toContainText(
        INVITE_CREATED_REGEX,
        { timeout: 15_000 }
      );

      // 3. Wallet user opens the shared accept-invite link and signs to join;
      //    acceptance signs the invite challenge with the stub wallet.
      const inviteId = await walletInviteId();
      await gotoAcceptInvite(walletPage, inviteId);
      await walletPage
        .getByRole("button", { name: SIGN_TO_JOIN_REGEX })
        .click();
      await expect(walletPage.locator("[data-sonner-toast]")).toContainText(
        WELCOME_REGEX,
        { timeout: 20_000 }
      );
    } finally {
      await walletCtx.close();
    }
  });

  test("inviting an unknown wallet address is rejected", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openInviteForm(page);
    await page
      .getByRole("button", { name: "Invite by wallet address instead" })
      .click();
    await page
      .getByPlaceholder(ADDRESS_INPUT)
      .fill("0x000000000000000000000000000000000000dEaD");
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      NOT_FOUND_REGEX,
      { timeout: 15_000 }
    );
  });
});
