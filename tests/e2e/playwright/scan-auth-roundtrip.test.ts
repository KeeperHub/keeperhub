/**
 * TEST-03: Scan → auth round-trip → workflow canvas (E2E scaffold).
 *
 * Prerequisites (manual, run once before this suite):
 *   pnpm dev:bootstrap   — seeds PERSISTENT_TEST_USER_EMAIL and pre-trusts
 *                          localhost; without it the signIn() step fails.
 *   pnpm dev             — dev server must be running at http://localhost:3000
 *
 * Run flags:
 *   --no-deps            — this test handles its own sign-in via a fresh
 *                          unauthenticated context; it does NOT depend on the
 *                          "setup" (auth.setup.ts) project.
 *
 * Scan API mocking:
 *   The test intercepts GET /api/scan/** (path param, not query) and fulfils
 *   it with a fixture ScanResponse containing one health-factor suggestion.
 *   No RPC or real network call is made to the scan service.
 *
 * Manual-only note (from 54-VALIDATION.md):
 *   This test requires a locally seeded database and a running dev server.
 *   Unit tests (scan-intent-cookie, pending-scan-runner, scan-wallet-check,
 *   scan-callback-url) carry the automated logic coverage in CI.
 *   The E2E test is skip-guarded below when the bootstrap sentinel is absent.
 */
import { expect, test } from "@playwright/test";
import {
  PERSISTENT_TEST_PASSWORD,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

// ---------------------------------------------------------------------------
// Bootstrap sentinel — skip gracefully when pnpm dev:bootstrap has not been run
// ---------------------------------------------------------------------------

/**
 * Returns true when the local dev DB appears to be bootstrapped.
 * We check for DATABASE_URL pointing to a localhost host only — if it points
 * to a remote host the test is not safe to run as a credential round-trip.
 */
function isBootstrapped(): boolean {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const localHosts = ["localhost", "127.0.0.1", "::1", "db", "postgres"];
  try {
    const host = new URL(dbUrl).hostname;
    return localHosts.some((h) => host === h);
  } catch {
    return false;
  }
}

const SKIP_REASON =
  "Requires pnpm dev:bootstrap (local DB seed). Run: pnpm dev:bootstrap && pnpm dev";

// ---------------------------------------------------------------------------
// Known address constant — any EVM address works because the scan API is mocked.
// Using a well-known Aave V3 address so the fixture is identifiable in logs.
// ---------------------------------------------------------------------------

const KNOWN_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// ---------------------------------------------------------------------------
// Fixture ScanResponse — fulfils the mocked /api/scan/** route.
// Uses locally-defined types to avoid importing from server-only lib/scan/types.
// ---------------------------------------------------------------------------

type FixtureSuggestion = {
  id: string;
  name: string;
  description: string;
  category: string;
  chainId: number;
  readOrWrite: "read" | "write";
  confirmInputs: Record<string, string>;
  riskNote: string;
  protocol: string;
  usdValue: number;
};

type FixtureScanResponse = {
  schemaVersion: number;
  address: string;
  positions: unknown[];
  stablecoins: unknown[];
  unavailableChains: unknown[];
  scannedAt: string;
  suggestions: FixtureSuggestion[];
};

const FIXTURE_SUGGESTION: FixtureSuggestion = {
  id: "health-aave-v3-1-e2e",
  name: "Aave V3 Health Factor Alert",
  description:
    "Monitor health factor (currently 1.80). Alert when it drops below 1.5.",
  category: "health",
  chainId: 1,
  readOrWrite: "read",
  confirmInputs: { threshold: "1.5" },
  riskNote: "Read-only monitoring workflow. No transactions are made.",
  protocol: "aave-v3",
  usdValue: 12_000,
};

const FIXTURE_SCAN_RESPONSE: FixtureScanResponse = {
  schemaVersion: 1,
  address: KNOWN_ADDRESS,
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
  suggestions: [FIXTURE_SUGGESTION],
};

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

const RE_WORKFLOWS_URL = /\/workflows\/[^/]+$/;
// String glob for context.route() — Playwright resolves string globs before
// the first network request fires, avoiding the regex-setup race condition
// that caused first-attempt flakiness when using a RegExp pattern.
const GLOB_SCAN_API = "**/api/scan/*";

// ---------------------------------------------------------------------------
// TEST-03 suite
// ---------------------------------------------------------------------------

test.describe("TEST-03: scan auth round-trip", () => {
  test("scan → suggestion preview → Save on schedule → sign in → workflow canvas", async ({
    browser,
  }) => {
    // Manual-only round-trip (see file header): CI coverage lives in the scan
    // unit tests. The localhost skip-guard below does not fire in CI because
    // CI's DB is also localhost, so gate on CI explicitly.
    if (process.env.CI) {
      test.skip(
        true,
        "Manual-only scan round-trip; CI coverage is the scan unit tests"
      );
      return;
    }

    // Skip gracefully when local DB is not seeded.
    if (!isBootstrapped()) {
      test.skip(true, SKIP_REASON);
      return;
    }

    // Fresh unauthenticated context — no stored auth state from auth.setup.ts.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      // -----------------------------------------------------------------
      // 1. Mock GET /api/scan/* — fulfil with fixture to avoid real RPC.
      //    The scan address is a path param: /api/scan/{address}
      //    Register at CONTEXT level (not page level) so the mock persists
      //    across any SPA navigation within the test.
      // -----------------------------------------------------------------
      await ctx.route(GLOB_SCAN_API, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(FIXTURE_SCAN_RESPONSE),
        });
      });

      // -----------------------------------------------------------------
      // 2. Navigate to /scan
      // -----------------------------------------------------------------
      await page.goto("/scan", { waitUntil: "domcontentloaded" });

      // -----------------------------------------------------------------
      // 3. Fill the address input (aria-label from ScanInput component)
      // -----------------------------------------------------------------
      const addressInput = page.locator("#scan-address");
      await expect(addressInput).toBeVisible({ timeout: 10_000 });
      await addressInput.fill(KNOWN_ADDRESS);

      // -----------------------------------------------------------------
      // 4. Submit the scan (click the Scan button)
      // -----------------------------------------------------------------
      await page.getByRole("button", { name: "Scan" }).click();

      // -----------------------------------------------------------------
      // 5. Wait for and click the first suggestion card
      //    (article[role="link"] from SuggestionCard component)
      // -----------------------------------------------------------------
      const card = page
        .locator('article[role="link"]')
        .filter({ hasText: "Aave V3 Health Factor Alert" });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();

      // -----------------------------------------------------------------
      // 6. Wait for the suggestion preview drawer to open
      // -----------------------------------------------------------------
      const drawer = page
        .locator('[role="dialog"], [data-radix-collection-item]')
        .first();
      await expect(drawer).toBeVisible({ timeout: 10_000 });

      // Click "Use this workflow": an anon visitor gets the auth prompt; an
      // already-resolved session goes straight to building the workflow.
      await page.getByRole("button", { name: "Use this workflow" }).click();

      // Sign in inline when the auth prompt appears. Do NOT call signIn(),
      // which navigates to "/" and races PendingScanRunner. The Sheet drawer
      // and the auth dialog both use role="dialog"; filter by the #auth-email
      // sign-in field.
      const authDialog = page
        .locator('[role="dialog"]')
        .filter({ has: page.locator("#auth-email") });
      if (await authDialog.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await authDialog
          .locator("#auth-email")
          .fill(PERSISTENT_TEST_USER_EMAIL);
        await authDialog
          .locator("#auth-password")
          .fill(PERSISTENT_TEST_PASSWORD);
        await authDialog
          .locator('button[type="submit"]:has-text("Sign in")')
          .click();
        await expect(authDialog).not.toBeVisible({ timeout: 15_000 });
      }

      // Skip-guard: if sign-in redirected to MFA enrollment the persistent
      // test user is not fully seeded. This indicates pnpm dev:bootstrap
      // has not been run (or ran without TOTP enrolment completing).
      if (page.url().includes("/enroll-mfa")) {
        test.skip(
          true,
          "MFA enrollment required — run pnpm dev:bootstrap to seed the test user with TOTP before running this suite"
        );
        return;
      }

      // -----------------------------------------------------------------
      // 9. PendingScanRunner (mounted in layout) reads the pending_scan
      //    cookie, builds + creates the workflow, then navigates.
      //    Wait for URL: /workflows/[id]
      // -----------------------------------------------------------------
      await page.waitForURL(RE_WORKFLOWS_URL, { timeout: 30_000 });

      // -----------------------------------------------------------------
      // 10. Verify the workflow canvas is visible
      // -----------------------------------------------------------------
      await expect(page.locator('[data-testid="workflow-canvas"]')).toBeVisible(
        { timeout: 15_000 }
      );
    } finally {
      await ctx.close();
    }
  });
});
