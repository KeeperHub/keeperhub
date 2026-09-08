/**
 * Discovery Test Harness
 *
 * NOT a real test suite. A scratchpad for iterative exploration.
 *
 * Workflow:
 * 1. Edit the EXPLORATION STEPS section below
 * 2. Run: pnpm test:e2e --grep "explore"
 * 3. Read probe outputs from .probes/ directory
 * 4. Edit steps again based on what you learned
 * 5. Once page structure is understood, write the real test in a new file
 *
 * Auto-probe mode (PW_DISCOVER=1):
 *   Automatically captures state on every URL change.
 *   Run: PW_DISCOVER=1 pnpm test:e2e --grep "explore"
 */

import { test } from "./fixtures";
import {
  autoProbe,
  clearHighlights,
  highlightElements,
  isDiscoveryMode,
  probe,
} from "./utils/discover";

test.describe("explore", () => {
  test.describe.configure({ mode: "serial" });

  // ================================================================
  // EXPLORATION STEPS - Edit this section, then run the test
  // ================================================================

  test("discover page", async ({ page }) => {
    // Auto-probe: captures state on every navigation when PW_DISCOVER=1
    const handle = await autoProbe(page);

    // Step 1: Navigate to the page you want to explore
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Step 2: Take a manual probe (always runs, even without PW_DISCOVER)
    await probe(page, "initial");

    // Step 3: Highlight elements for annotated screenshot
    await highlightElements(page, { visible: true });
    await page.screenshot({
      path: "tests/e2e/playwright/.probes/highlighted.png",
      fullPage: true,
    });
    await clearHighlights(page);

    // Step 4: Interact to reveal new state, then probe again
    // Examples (uncomment/modify as needed):
    //
    // Click a button:
    //   await page.locator('button:has-text("Sign In")').first().click();
    //   await probe(page, "after-click-signin");
    //
    // Fill a form:
    //   await page.locator('#email').fill('test@example.com');
    //   await probe(page, "after-fill-email");
    //
    // Wait for dialog:
    //   await page.locator('[role="dialog"]').waitFor({ state: 'visible' });
    //   await probe(page, "dialog-open");
    //
    // Hover to reveal tooltip/menu:
    //   await page.locator('[data-testid="user-menu"]').hover();
    //   await probe(page, "menu-hover");
    //
    // Select from dropdown (Radix combobox):
    //   await page.locator('button[role="combobox"]').click();
    //   await probe(page, "dropdown-open");

    // Stop auto-probe listener
    const autoProbes = handle.stop();
    if (isDiscoveryMode() && autoProbes.length > 0) {
      console.log(
        `Auto-probe captured ${autoProbes.length} state(s) during navigation`
      );
    }
  });
});
