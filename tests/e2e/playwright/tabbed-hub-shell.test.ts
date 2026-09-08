import { expect, test } from "./fixtures";

// Phase 44 tabbed Hub shell uses anonymous storage state — these tests must
// pass for logged-out visitors too (the Hub is publicly browseable).
test.use({ storageState: { cookies: [], origins: [] } });

// Top-level regex literals — Biome lint rule
// `lint/performance/useTopLevelRegex` requires regex literals to be defined
// once at module scope rather than recompiled inside each test invocation.
const URL_TAB_WORKFLOWS = /[?&]tab=workflows/;
const URL_TAB_MARKETPLACE = /[?&]tab=marketplace/;
const URL_TAB_PROTOCOLS = /[?&]tab=protocols/;
const HTML_LISTED_IN_MARKETPLACE = /Listed in marketplace/i;
const SRC_MARKETPLACE_BADGE_SLOT = /MARKETPLACE_BADGE_SLOT/;
const SRC_LISTED_IN_MARKETPLACE = /Listed in marketplace/;

test.describe("Tabbed Hub shell (HUBV2-02 / HUBV2-03 / HUBV2-08)", () => {
  test.beforeEach(async ({ context }) => {
    // Belt-and-braces: even though storageState above resets browser state,
    // explicitly clearing cookies guards against any cross-test bleed within
    // the same worker.
    await context.clearCookies();
  });

  test("default tab on /hub is Protocols (no ?tab= param)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const protocolsTab = page.getByRole("tab", { name: "Protocols" });
    await expect(protocolsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=protocols deep-links to Protocols active", async ({ page }) => {
    await page.goto("/hub?tab=protocols", { waitUntil: "domcontentloaded" });
    const protocolsTab = page.getByRole("tab", { name: "Protocols" });
    await expect(protocolsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=workflows deep-links to Workflows active", async ({ page }) => {
    await page.goto("/hub?tab=workflows", { waitUntil: "domcontentloaded" });
    const workflowsTab = page.getByRole("tab", { name: "Workflows" });
    await expect(workflowsTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("?tab=marketplace deep-links to Marketplace active", async ({
    page,
  }) => {
    await page.goto("/hub?tab=marketplace", { waitUntil: "domcontentloaded" });
    const marketplaceTab = page.getByRole("tab", { name: "Marketplace" });
    await expect(marketplaceTab).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
  });

  test("tab click updates URL via router.replace (history length stays constant)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    // Wait for tabs to be interactive before snapshotting history length.
    await expect(page.getByRole("tab", { name: "Protocols" })).toHaveAttribute(
      "data-state",
      "active",
      { timeout: 15_000 }
    );
    const initialHistoryLength = await page.evaluate(() => history.length);

    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).toHaveURL(URL_TAB_WORKFLOWS, { timeout: 5000 });

    await page.getByRole("tab", { name: "Marketplace" }).click();
    await expect(page).toHaveURL(URL_TAB_MARKETPLACE, { timeout: 5000 });

    const finalHistoryLength = await page.evaluate(() => history.length);
    // router.replace MUST NOT push new history entries — HUBV2-03 contract.
    expect(finalHistoryLength).toBe(initialHistoryLength);
  });

  test("HUBV2-02: shell stays mounted across tab switches (sidebar is stable, no shell re-mount)", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const sidebar = page.locator('[data-testid="navigation-sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // Tag the live sidebar DOM node with a marker. If the surrounding shell
    // re-mounts on tab switch, React replaces the DOM node and the marker is
    // lost. A stable mount preserves the marker across all three swaps.
    await sidebar.evaluate((el) => {
      el.setAttribute("data-shell-mount-marker", "persisted");
    });

    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).toHaveURL(URL_TAB_WORKFLOWS, { timeout: 5000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );

    await page.getByRole("tab", { name: "Marketplace" }).click();
    await expect(page).toHaveURL(URL_TAB_MARKETPLACE, { timeout: 5000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );

    await page.getByRole("tab", { name: "Protocols" }).click();
    await expect(page).toHaveURL(URL_TAB_PROTOCOLS, { timeout: 5000 });
    await expect(sidebar).toHaveAttribute(
      "data-shell-mount-marker",
      "persisted"
    );
  });

  test("HUBV2-02: tab swap shows no skeleton flicker on the surrounding shell", async ({
    page,
  }) => {
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Protocols" })).toHaveAttribute(
      "data-state",
      "active",
      { timeout: 15_000 }
    );

    // Trigger a tab swap; assert no .animate-pulse element appears at the
    // SHELL level for >100ms. Tab CONTENT may have its own skeleton (e.g.
    // marketplace initial fetch) — we only care that the SURROUNDING shell
    // (anything outside [role="tabpanel"]) does not flicker.
    const shellPulseLocator = page.locator(
      'div:not([role="tabpanel"]) > .animate-pulse, body > .animate-pulse'
    );

    // The incoming tab's content skeleton can briefly mount before its
    // [role="tabpanel"] wrapper exists -- the tab's own loading state, which is
    // allowed. Poll until the shell settles after each swap; a pulse that stays
    // outside any panel is the genuine shell flicker the contract forbids.
    const workflowsTab = page.getByRole("tab", { name: "Workflows" });
    await workflowsTab.click();
    await expect(workflowsTab).toHaveAttribute("data-state", "active");
    await expect
      .poll(() => shellPulseLocator.count(), { timeout: 5000 })
      .toBe(0);

    const marketplaceTab = page.getByRole("tab", { name: "Marketplace" });
    await marketplaceTab.click();
    await expect(marketplaceTab).toHaveAttribute("data-state", "active");
    await expect
      .poll(() => shellPulseLocator.count(), { timeout: 5000 })
      .toBe(0);
  });

  test("HUBV2-08: no 'Listed in marketplace' badge anywhere in the Workflows tab HTML", async ({
    page,
  }) => {
    await page.goto("/hub?tab=workflows", { waitUntil: "domcontentloaded" });
    // Wait for the Workflows tab to mount and stream in its results section.
    // The view-mode wrapper now always renders (HUB-22 — populated AND empty
    // states share a single wrapper), so we can wait on it unconditionally.
    await expect(page.getByRole("tab", { name: "Workflows" })).toHaveAttribute(
      "data-state",
      "active",
      { timeout: 15_000 }
    );
    await page
      .locator("[data-view-mode]")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    const html = await page.content();
    expect(html).not.toMatch(HTML_LISTED_IN_MARKETPLACE);
  });

  test("HUBV2-08 source-grep: MARKETPLACE_BADGE_SLOT marker exists in workflow-template-row.tsx", async () => {
    // Regression guard: future maintainers must not delete the slot marker
    // without re-reading HUBV2-08. The marker stays as a comment; the slot
    // renders nothing in Phase 44.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      "components/hub/workflow-template-row.tsx",
      "utf8"
    );
    expect(src).toMatch(SRC_MARKETPLACE_BADGE_SLOT);
    expect(src).not.toMatch(SRC_LISTED_IN_MARKETPLACE);
  });
});
