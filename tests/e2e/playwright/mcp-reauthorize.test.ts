/**
 * KEEP-483: smoke test for the /settings/mcp/reauthorize stub page that
 * the `insufficient_scope` MCP error envelope's `upgrade_url` points at.
 *
 * Asserts:
 *  - the route returns 200 (not a 404)
 *  - the page renders the granted + required scope strings from the
 *    query string so the user knows what's missing
 *  - the primary "Re-authorize" link points at the OAuth consent screen
 *    with the full mcp:read mcp:write scope set pre-selected
 *
 * Runs anonymously — the page is intentionally not auth-gated; the
 * recovery affordance must work whether the user has a session or not.
 */
import { expect, test } from "./fixtures";

// Top-level regex literals per Biome's useTopLevelRegex rule — these
// are reused across every assertion in this file.
const REAUTHORIZE_HEADING_RE = /reauthorize mcp access/i;
const REAUTHORIZE_LINK_RE = /re-authorize/i;

// Force a fresh anonymous context so a persisted authenticated session
// from auth.setup.ts can't change the page render.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("/settings/mcp/reauthorize stub page (KEEP-483)", () => {
  test("returns 200 and renders granted + required scope from query params", async ({
    page,
  }) => {
    const response = await page.goto(
      "/settings/mcp/reauthorize?required=mcp:write&granted=mcp:read",
      { waitUntil: "domcontentloaded" }
    );

    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);

    const body = page.locator("body");
    await expect(body).toContainText("mcp:read");
    await expect(body).toContainText("mcp:write");
    await expect(
      page.getByRole("heading", { name: REAUTHORIZE_HEADING_RE })
    ).toBeVisible();
  });

  test("re-authorize link points at /oauth/authorize with full scope set", async ({
    page,
  }) => {
    await page.goto(
      "/settings/mcp/reauthorize?required=mcp:write&granted=mcp:read",
      { waitUntil: "domcontentloaded" }
    );

    const reauthorizeLink = page.getByRole("link", {
      name: REAUTHORIZE_LINK_RE,
    });
    await expect(reauthorizeLink).toBeVisible();
    await expect(reauthorizeLink).toHaveAttribute(
      "href",
      "/oauth/authorize?scope=mcp:read+mcp:write&intent=upgrade"
    );
  });
});
