import { expect, test } from "@playwright/test";
import { scanResponseFixture } from "./fixtures/scan-response.fixture";

// Force anonymous context for all scan tests — the /scan page is accessible
// without authentication (SCANUI-01: no redirect, no auth check, no signup wall).
test.use({ storageState: { cookies: [], origins: [] } });

const SCAN_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const INVALID_ADDRESS = "not-a-valid-address";
const SCAN_URL_REGEX = /\/scan/;
const SCANNED_COUNT_REGEX = /Scanned 5 of 6 supported networks/;
const AUTH_COPY_REGEX = /sign in|create account/i;

test.describe("scan", () => {
  /**
   * SCANUI-01: Anonymous /scan load renders the address input without any
   * redirect or auth check. The page is intentionally unauthenticated.
   */
  test("SCANUI-01: anonymous /scan load renders address input without redirect", async ({
    page,
  }) => {
    await page.goto("/scan", { waitUntil: "load" });

    // Page must stay on /scan — no redirect to / or /login
    await expect(page).toHaveURL(SCAN_URL_REGEX);

    // Address input must be present (id="scan-address" per UI-SPEC §1)
    await expect(page.locator("#scan-address")).toBeVisible({
      timeout: 15_000,
    });
  });

  /**
   * SCANUI-01: An invalid address triggers the inline validation error without
   * making an API call (client-side regex check before fetch).
   */
  test("SCANUI-01: invalid address shows inline error without an API call", async ({
    page,
  }) => {
    let apiCallMade = false;
    page.on("request", (req) => {
      if (req.url().includes("/api/scan/")) {
        apiCallMade = true;
      }
    });

    // waitUntil: 'load' ensures the Turbopack JS bundle is downloaded and React
    // has hydrated before we interact — domcontentloaded fires before hydration.
    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(INVALID_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    // Inline error paragraph (id="scan-error", role="alert" per UI-SPEC §10)
    await expect(page.locator("#scan-error")).toBeVisible({ timeout: 5000 });
    expect(apiCallMade).toBe(false);
  });

  /**
   * SCANUI-02: After a successful scan (route-mocked), suggestion cards render
   * the name, category badge, chain name, and read/write pill.
   */
  test("SCANUI-02: suggestion cards render name/category/chain/read-write on scan results", async ({
    page,
  }) => {
    await page.route("**/api/scan/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scanResponseFixture),
      });
    });

    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(SCAN_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    // At least one suggestion card must appear (article[role="link"] per UI-SPEC §1)
    const firstCard = page.locator("article[role='link']").first();
    // 30 s gives Turbopack time to finish lazy compilation on first cold run.
    await expect(firstCard).toBeVisible({ timeout: 30_000 });

    // Fixture suggestion[0]: category="health", name="Aave V3 Health Factor Alert",
    // chainId=1 ("Ethereum"), readOrWrite="read" (pill label "read-only").
    // exact: true avoids strict-mode violations — "Health" and "Ethereum" both
    // appear multiple times in the card's description and heading text.
    await expect(firstCard.getByText("Health", { exact: true })).toBeVisible();
    await expect(
      firstCard.getByText("Aave V3 Health Factor Alert", { exact: true })
    ).toBeVisible();
    await expect(
      firstCard.getByText("Ethereum", { exact: true })
    ).toBeVisible();
    await expect(
      firstCard.getByText("read-only", { exact: true })
    ).toBeVisible();
  });

  /**
   * SCANUI-03: Clicking a suggestion card opens the Sheet drawer and renders
   * the read-only WorkflowCanvas inside it.
   */
  test("SCANUI-03: card click opens Sheet drawer with workflow canvas", async ({
    page,
  }) => {
    await page.route("**/api/scan/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scanResponseFixture),
      });
    });

    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(SCAN_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    await page.locator("article[role='link']").first().click();

    // Sheet drawer must contain the workflow canvas (data-testid="workflow-canvas")
    await expect(page.locator('[data-testid="workflow-canvas"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  /**
   * SCANUI-04: Clicking the Run CTA while anonymous opens the auth dialog
   * (via openAuthPrompt). Address and selected suggestion are preserved in
   * page state — no context loss on auth redirect.
   */
  test("SCANUI-04: anonymous Run CTA opens auth dialog without losing scan context", async ({
    page,
  }) => {
    await page.route("**/api/scan/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scanResponseFixture),
      });
    });

    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(SCAN_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    // Open the preview drawer
    await page.locator("article[role='link']").first().click();
    await page
      .locator('[data-testid="workflow-canvas"]')
      .waitFor({ state: "visible", timeout: 10_000 });

    // Click the Run CTA (labeled "Use this workflow") -> openAuthPrompt scan-run.
    await page.getByRole("button", { name: "Use this workflow" }).click();

    // Auth dialog must open. The Sheet drawer is also role="dialog"; filter to
    // the one containing sign-in copy (AuthDialog shows "Sign in" or equivalent).
    await expect(
      page.locator('[role="dialog"]').filter({ hasText: AUTH_COPY_REGEX })
    ).toBeVisible({ timeout: 5000 });
  });

  /**
   * SCANUI-05: Results header reflects unavailable chains in the scanned
   * count (per-chain badges were dropped in favor of the count line) and
   * shows the depeg warning banner when the fixture has unavailableChains +
   * depegged stablecoin.
   */
  test("SCANUI-05: results header reflects unavailable chains and shows depeg banner", async ({
    page,
  }) => {
    await page.route("**/api/scan/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scanResponseFixture),
      });
    });

    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(SCAN_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    // Wait for scan results to render
    await expect(page.locator("article[role='link']").first()).toBeVisible({
      timeout: 15_000,
    });

    // Fixture: unavailableChains = [{ chainId: 1, reason: "timeout" }] —
    // one of the six supported networks is excluded from the scanned count.
    await expect(page.getByText(SCANNED_COUNT_REGEX)).toBeVisible();

    // Fixture: stablecoins = [{ symbol: "USDC", depegged: true }]
    // DepegBanner renders with role="alert" and contains the symbol name
    await expect(
      page.locator('[role="alert"]').filter({ hasText: "USDC" }).first()
    ).toBeVisible();
  });

  /**
   * SCANUI-01 (rate limit): a 429 response renders the rate-limit banner with
   * the retry window converted from API seconds to whole MINUTES. Guards the
   * seconds-vs-minutes unit bug — the API returns retryAfter in seconds (3600),
   * the banner must read "60 minutes", never "3600 minutes".
   */
  test("SCANUI-01: 429 renders rate-limit banner with seconds converted to minutes", async ({
    page,
  }) => {
    await page.route("**/api/scan/**", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Rate limit exceeded",
          retryAfter: 3600,
        }),
      });
    });

    await page.goto("/scan", { waitUntil: "load" });
    await page.locator("#scan-address").fill(SCAN_ADDRESS);
    await page.getByRole("button", { name: "Scan" }).click();

    const banner = page.locator('[data-testid="scan-results-rate-limited"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // 3600 seconds -> 60 minutes (not "3600 minutes").
    await expect(banner).toContainText("60 minute");
    await expect(banner).not.toContainText("3600");
  });
});
