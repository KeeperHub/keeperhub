import { expect, test } from "./fixtures";

// Anonymous storage state — the Marketplace tab is publicly browseable, and
// the privacy assertion below MUST hold for unauthenticated visitors (the
// strictest case — no per-org filtering applies).
test.use({ storageState: { cookies: [], origins: [] } });

// MARKET-13 privacy whitelist: any leak of these column names in the
// rendered HTML for /hub?tab=marketplace fails this suite. Easy to extend
// if a future SELECT adds a new sensitive column.
const BANNED_TOKENS = [
  "creatorWalletAddress",
  "userId",
  "organizationId",
  "payerAddress",
  "amountUsdc",
] as const;

// Top-level regex literals — Biome lint rule
// `lint/performance/useTopLevelRegex` requires regex literals to live at
// module scope so they are compiled once instead of on every test invocation.
const URL_SORT_NEWEST = /[?&]sort=newest/;
const URL_TAB_MARKETPLACE = /[?&]tab=marketplace/;
const URL_SORT_POPULAR = /[?&]sort=popular/;
const URL_TAB_WORKFLOWS = /[?&]tab=workflows/;
const NAME_EARNINGS = /earnings/i;

test.describe("Marketplace tab (MARKET-13)", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("loads /hub?tab=marketplace and renders leaderboard or empty state", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    // Either the leaderboard table renders, or the empty state. Both are
    // acceptable in a cold-start dev environment without seeded payments.
    const leaderboard = page.getByRole("table", {
      name: "Marketplace leaderboard",
    });
    const empty = page.getByText("No paid services listed yet.");
    await expect(leaderboard.or(empty).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("HTML rendered for /hub?tab=marketplace does not leak sensitive columns", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    // Wait for marketplace render to settle. Use exact match so the
    // empty-state inner section (`aria-label="No marketplace results"`)
    // doesn't fuzzy-match this selector.
    await page
      .getByRole("region", { name: "Marketplace results", exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    const html = await page.content();
    for (const banned of BANNED_TOKENS) {
      expect(
        html,
        `Expected no leak of '${banned}' in /hub?tab=marketplace HTML`
      ).not.toContain(banned);
    }
  });

  test("sort sidebar switches between Popular and Newest, updating ?sort= URL param", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    // Sidebar Sort section is a radiogroup; each option is a role=radio
    // button. The dropdown was replaced with this sidebar in 44-tweaks.
    const sortGroup = page.getByRole("radiogroup", {
      name: "Sort marketplace by",
    });
    await expect(sortGroup).toBeVisible({ timeout: 15_000 });
    // Default sort is Popular.
    await expect(
      sortGroup.getByRole("radio", { name: "Popular" })
    ).toHaveAttribute("aria-checked", "true");

    // Switch to Newest.
    await sortGroup.getByRole("radio", { name: "Newest" }).click();
    await expect(page).toHaveURL(URL_SORT_NEWEST, { timeout: 5000 });
    // URL should still carry tab=marketplace alongside sort=newest.
    await expect(page).toHaveURL(URL_TAB_MARKETPLACE);
    await expect(
      sortGroup.getByRole("radio", { name: "Newest" })
    ).toHaveAttribute("aria-checked", "true");

    // Switch back to Popular.
    await sortGroup.getByRole("radio", { name: "Popular" }).click();
    await expect(page).toHaveURL(URL_SORT_POPULAR, { timeout: 5000 });
    await expect(
      sortGroup.getByRole("radio", { name: "Popular" })
    ).toHaveAttribute("aria-checked", "true");
  });

  test("sort sidebar does NOT expose Earnings option (MARKET-02 deferred)", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    const sortGroup = page.getByRole("radiogroup", {
      name: "Sort marketplace by",
    });
    await expect(sortGroup).toBeVisible({ timeout: 15_000 });
    // Assert no radio with "Earnings" / "earnings". The earnings/revenue
    // sort is explicitly deferred (MARKET-FUTURE-01).
    const earningsOption = sortGroup.getByRole("radio", {
      name: NAME_EARNINGS,
    });
    await expect(earningsOption).toHaveCount(0);
  });

  test("HUBV2-02: tab swap from Marketplace to Workflows does not flicker the shell", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("tab", { name: "Marketplace" })
    ).toHaveAttribute("data-state", "active", { timeout: 15_000 });

    // Sidebar must stay mounted across the swap (stable shell contract).
    const sidebar = page.locator('[data-testid="navigation-sidebar"]');
    await expect(sidebar).toBeVisible();
    await sidebar.evaluate((el) => {
      el.setAttribute("data-shell-mount-marker", "persisted");
    });

    const shellPulseLocator = page.locator(
      'div:not([role="tabpanel"]) > .animate-pulse, body > .animate-pulse'
    );

    const workflowsTab = page.getByRole("tab", { name: "Workflows" });
    await workflowsTab.click();
    await expect(workflowsTab).toHaveAttribute("data-state", "active");
    // The incoming tab's content skeleton can briefly mount before its
    // [role="tabpanel"] wrapper exists -- the tab's own loading state, which is
    // allowed. Poll until the shell settles; a pulse that stays outside any
    // panel is the genuine shell flicker the contract forbids.
    await expect
      .poll(() => shellPulseLocator.count(), { timeout: 5000 })
      .toBe(0);
    await expect(page).toHaveURL(URL_TAB_WORKFLOWS);
    // Marker survives → shell did not re-mount.
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );
  });
});
