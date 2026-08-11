import { expect, test } from "./fixtures";
import { getDbConnection } from "./utils/connection";
import {
  completeWalletLogin,
  installWalletStub,
  TEST_WALLET_ADDRESS,
} from "./utils/wallet-stub";

// Org-level MFA enforcement for wallet (SIWE) users. The proxy hard-gates
// non-compliant wallet members to /enforce-mfa until they enroll a required
// factor. This test exercises the full cycle: turn on enforcement, verify the
// gate blocks, enroll a step-up email, verify the gate lifts.
//
// The suite sends the `x-load-test-mfa-bypass` header on every request (see
// playwright.config.ts) so persistent non-2FA users are not walled by the
// mandatory-MFA gate. That same header short-circuits the proxy MFA gate this
// spec is asserting, so clear it here: these requests must reach the wallet
// enforcement branch.
test.use({
  storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { "x-load-test-mfa-bypass": "" },
});

const ENFORCE_MFA_URL_REGEX = /\/enforce-mfa/;

async function getWalletOrgId(): Promise<string | null> {
  const sql = getDbConnection();
  try {
    const rows = await sql`
      select m.organization_id
      from member m
      join wallet_address w on w.user_id = m.user_id
      where lower(w.address) = ${TEST_WALLET_ADDRESS.toLowerCase()}
      limit 1`;
    return (rows[0]?.organization_id as string | undefined) ?? null;
  } finally {
    await sql.end();
  }
}

async function setOrgEnforcement(
  orgId: string,
  enforce: boolean
): Promise<void> {
  const sql = getDbConnection();
  try {
    await sql`
      update organization
      set enforce_mfa = ${enforce},
          enforced_mfa_factors = ${enforce ? JSON.stringify(["email"]) : null}
      where id = ${orgId}`;
  } finally {
    await sql.end();
  }
}

async function clearWalletStepUpEmail(): Promise<void> {
  const sql = getDbConnection();
  try {
    await sql`
      update users
      set step_up_email = null
      from wallet_address w
      where users.id = w.user_id
        and lower(w.address) = ${TEST_WALLET_ADDRESS.toLowerCase()}`;
  } finally {
    await sql.end();
  }
}

test.describe("wallet org-MFA enforcement gate", () => {
  test.beforeEach(async ({ page }) => {
    await installWalletStub(page);
    await completeWalletLogin(page);
    await clearWalletStepUpEmail();
  });

  test.afterEach(async () => {
    const orgId = await getWalletOrgId();
    if (orgId) {
      await setOrgEnforcement(orgId, false);
    }
    await clearWalletStepUpEmail();
  });

  test("redirects to /enforce-mfa when org requires a factor the wallet user lacks", async ({
    page,
  }) => {
    const orgId = await getWalletOrgId();
    if (!orgId) {
      test.skip(true, "wallet user has no org membership yet");
      return;
    }

    await setOrgEnforcement(orgId, true);

    // Navigate away and back; the proxy should now redirect to /enforce-mfa.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(ENFORCE_MFA_URL_REGEX, { timeout: 10_000 });
    await expect(page.getByText("Two-factor required")).toBeVisible();

    // API requests are also gated: the proxy returns 403 with the correct code.
    const apiRes = await page.request.get("/api/api-keys");
    expect(apiRes.status()).toBe(403);
    const body = (await apiRes.json()) as { code?: string };
    expect(body.code).toBe("org_mfa_enrollment_required");
  });

  test("gate lifts after enrolling the required factor", async ({ page }) => {
    const orgId = await getWalletOrgId();
    if (!orgId) {
      test.skip(true, "wallet user has no org membership yet");
      return;
    }

    await setOrgEnforcement(orgId, true);

    // Navigate to trigger the gate.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(ENFORCE_MFA_URL_REGEX, { timeout: 10_000 });

    // Directly seed the step-up email via the API (no real inbox needed).
    // Using the test wallet's session the page already carries.
    const sql = getDbConnection();
    try {
      await sql`
        update users
        set step_up_email = 'wallet-e2e-test@example.com'
        from wallet_address w
        where users.id = w.user_id
          and lower(w.address) = ${TEST_WALLET_ADDRESS.toLowerCase()}`;
    } finally {
      await sql.end();
    }

    // Reload: compliance check should now pass and the gate should not redirect.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(ENFORCE_MFA_URL_REGEX, {
      timeout: 10_000,
    });

    // API is also unblocked.
    const apiRes = await page.request.get("/api/api-keys");
    expect(apiRes.status()).toBe(200);
  });
});
