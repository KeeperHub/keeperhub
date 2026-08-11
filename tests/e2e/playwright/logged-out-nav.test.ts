import { expect, test } from "./fixtures";
import { enterAsGuest } from "./utils/auth";

// Force a fresh anonymous context for every test in this file. The default
// Playwright project may carry over the persisted "authenticated" storageState
// from auth.setup.ts; resetting cookies/origins guarantees the sidebar renders
// in its logged-out branch.
test.use({ storageState: { cookies: [], origins: [] } });

const HYDRATION_REGEX = /hydrat/i;
const SIGN_IN_TEXT_REGEX = /sign in|welcome|log in|create account/i;
const ANALYTICS_PATH_REGEX = /\/analytics/;

test.describe("Logged-out navigation sidebar (NAV-01..05, NAV-08)", () => {
  // A visitor with no session is now walled at /welcome; the logged-out canvas
  // (with its sidebar) is reached through the "Explore without signing in"
  // guest path, which mints an anonymous session and sets the continue-as-guest
  // flag. Establish that once per test so the sidebar renders.
  test.beforeEach(async ({ page }) => {
    await enterAsGuest(page);
  });

  test("Anonymous load: every nav item is visible (NAV-01)", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The sidebar wrapper renders only after the better-auth session resolves
    // (NAV-03 hydration gate). Wait for it before asserting children.
    await expect(
      page.locator('[data-testid="navigation-sidebar"]')
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="nav-workflows"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-hub"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-analytics"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-earnings"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="nav-address-book"]')
    ).toBeVisible();

    // Plan 42-06 explicitly removed the import nav item.
    expect(await page.locator('[data-testid="nav-import"]').count()).toBe(0);
  });

  test("Anonymous load: zero 401 responses in network log (NAV-04, NAV-08)", async ({
    page,
  }) => {
    // The better-auth organization client plugin auto-fetches the active org
    // after session bootstrap (via internal nanostore subscription, not via
    // any of our consumers). The response is a benign 401 for anonymous
    // users — not user-facing spam. Treat it as an upstream-library
    // bootstrap call and exclude it from the contract: NAV-04's intent is
    // that OUR persistent components (sidebar, toolbar, user menu, wallet
    // button, org switcher) do not fire protected fetches for anon users.
    const UPSTREAM_ALLOWLIST = ["/api/auth/organization/get-full-organization"];

    const status401: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (
        response.status() === 401 &&
        !UPSTREAM_ALLOWLIST.some((path) => url.includes(path))
      ) {
        status401.push(url);
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Wait until the sidebar has had a chance to fire (or skip) any data fetches.
    await expect(
      page.locator('[data-testid="navigation-sidebar"]')
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    expect(
      status401,
      `Saw 401 responses (NAV-04 contract violated): ${status401.join(", ")}`
    ).toEqual([]);
  });

  test("Anonymous load: zero hydration warnings in console (NAV-03, NAV-08)", async ({
    page,
  }) => {
    const hydrationWarnings: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        (message.type() === "error" || message.type() === "warning") &&
        HYDRATION_REGEX.test(text)
      ) {
        hydrationWarnings.push(text);
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="navigation-sidebar"]')
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    expect(
      hydrationWarnings,
      `Saw hydration warnings (NAV-03 contract violated):\n${hydrationWarnings.join("\n")}`
    ).toEqual([]);
  });

  test("Clicking a requireAuth nav item opens the auth modal (NAV-02, NAV-06, NAV-08)", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="navigation-sidebar"]')
    ).toBeVisible({ timeout: 15_000 });

    const startUrl = page.url();
    await page.locator('[data-testid="nav-analytics"]').click();

    // The shared AuthDialog (controlled by useAuthPrompt) appears.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const dialogText = (await dialog.textContent()) ?? "";
    expect(dialogText).toMatch(SIGN_IN_TEXT_REGEX);

    // The URL must NOT navigate away to /analytics — the auth gate prevents
    // the route push.
    expect(page.url()).not.toMatch(ANALYTICS_PATH_REGEX);
    expect(page.url()).toBe(startUrl);
  });

  test("Org switcher does not render when signed out (NAV-05)", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="navigation-sidebar"]')
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // OrgSwitcher uses `button[role="combobox"]`. It must not exist for
    // anonymous/signed-out users.
    expect(await page.locator('button[role="combobox"]').count()).toBe(0);
  });
});
