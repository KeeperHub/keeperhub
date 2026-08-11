/**
 * Phase 45 BFCACHE-04: end-to-end coverage of back/forward hydration recovery.
 *
 * Runs the SAME test against two Next.js webServer modes:
 *   - dev  (default; `pnpm dev`)              — asserts the root-layout
 *                                                 workaround FIRES on goBack
 *                                                 (navigation.type === 'reload').
 *   - prod (NEXT_BUILD_MODE=production;        — asserts the page rehydrates
 *           `pnpm build && pnpm start`)         WITHOUT a reload-driven recovery
 *                                                 (navigation.type !== 'reload').
 *
 * Mode is selected by the NEXT_BUILD_MODE env var read in playwright.config.ts.
 * Run via `pnpm test:e2e:bfcache:dev` or `pnpm test:e2e:bfcache:prod`.
 *
 * The test relies on the persistent test user's storageState (set up by the
 * `chromium` project in playwright.config.ts:66-72) so /billing renders. The
 * org switcher button (`button[role="combobox"]`) is the hydration sentinel —
 * it only renders after AuthProvider hydrates client-side, so its visibility
 * proves the React tree finished hydrating.
 */
import { expect, test } from "@playwright/test";

const isProdMode = process.env.NEXT_BUILD_MODE === "production";
const buildModeLabel = isProdMode ? "pnpm start" : "pnpm dev";

// Both /hub and /billing — covers two distinct client-component-heavy pages
// per CONTEXT.md `### Test Coverage`. /billing requires auth; the persistent
// test user storageState satisfies that.
const PAGES_TO_TEST = ["/hub", "/billing"] as const;

test.describe(`back/forward hydration recovery (${buildModeLabel})`, () => {
  for (const targetPath of PAGES_TO_TEST) {
    test(`${targetPath}: hydrates after back navigation`, async ({ page }) => {
      // Component-level fetches (e.g. <BillingDetails> on /billing) render
      // conditional buttons only after their useEffect fetch resolves —
      // hide their "Loading..." indicator at that point. The hydration
      // sentinel below proves AuthProvider hydrated; it does NOT prove
      // those fetches are done. Without this wait the baseline (fresh
      // nav) usually wins the race and the rehydrated count (back nav)
      // usually loses it, producing a deterministic off-by-one.
      const settleClientDataFetches = async (): Promise<void> => {
        await expect(page.getByText("Loading...", { exact: true })).toBeHidden({
          timeout: 10_000,
        });
      };

      // 1. Navigate to target page first; wait for hydration sentinel.
      await page.goto(targetPath, { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });
      await settleClientDataFetches();

      // 2. Capture button count after fresh hydration as the baseline.
      const baselineButtonCount = await page.locator("button").count();
      expect(baselineButtonCount).toBeGreaterThan(0);

      // 3. Navigate away (use the OTHER target as the elsewhere page).
      const elsewhere = targetPath === "/hub" ? "/billing" : "/hub";
      await page.goto(elsewhere, { waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });

      // 4. Browser back to the original target. Use domcontentloaded — load
      //    fires before hydration completes (45-RESEARCH.md Pitfall 4), so
      //    we follow up with the sentinel wait.
      await page.goBack({ waitUntil: "domcontentloaded" });
      await expect(page.locator('button[role="combobox"]')).toBeVisible({
        timeout: 15_000,
      });
      await settleClientDataFetches();

      // 5. Behavior assertion: the rehydrated page has at least as many
      //    interactive buttons as the fresh-nav baseline. This is the proxy
      //    for "the React tree fully hydrated" per success-criterion #1
      //    (45-RESEARCH.md Pitfall 5 — DOM internal markers like
      //    __reactContainer are properties not attributes; behavioral
      //    assertions are the contract).
      // Poll instead of a single snapshot: settleClientDataFetches keys off a
      // "Loading..." sentinel that some pages (e.g. /hub) render as skeletons
      // instead, so the count can be read mid-hydration. Wait for it to reach
      // the baseline.
      await expect
        .poll(() => page.locator("button").count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(baselineButtonCount);

      // 6. Build-mode-specific navigation-type assertion.
      const navType = await page.evaluate(() => {
        const entries = performance.getEntriesByType("navigation");
        return entries.length > 0
          ? (entries[0] as PerformanceNavigationTiming).type
          : null;
      });

      if (isProdMode) {
        // Prod must hydrate after back/forward WITHOUT relying on a reload.
        // If 'reload' is observed in prod the build-time DCE gate is broken
        // OR the underlying race exists in prod too (escalation: scope expands).
        expect(navType).not.toBe("reload");
      } else {
        // Dev: the workaround MUST have fired. The recovery turns the
        // back_forward navigation into a reload, so the navigation type
        // observed AFTER the reload is 'reload' (success-criterion #4).
        expect(navType).toBe("reload");
      }
    });
  }
});
