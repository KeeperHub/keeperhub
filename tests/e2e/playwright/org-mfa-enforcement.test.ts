import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openOrgSettings } from "./utils/settings";

const UPDATED_REGEX = /enforcement updated/i;
const NEEDS_FACTOR_REGEX = /at least one factor/i;

// Org-level MFA enforcement (owner-only Security tab). Runs as the persistent
// test user, who owns their personal org. Exercises the owner toggle round-trip
// end-to-end; the wallet-member proxy gate is covered separately.

async function openOrgSecurityTab(page: Page): Promise<void> {
  await openOrgSettings(page, "security");
  // The section fetches its current state before rendering; wait for the toggle
  // so callers don't race the loading spinner.
  await expect(page.getByTestId("org-mfa-enforce-toggle")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("org MFA enforcement (owner)", () => {
  test("owner enables enforcement with a factor and it persists", async ({
    page,
  }) => {
    await openOrgSecurityTab(page);

    const enforceToggle = page.getByTestId("org-mfa-enforce-toggle");
    await expect(enforceToggle).toBeVisible();

    // Turn enforcement on, require TOTP, save.
    if ((await enforceToggle.getAttribute("data-state")) !== "checked") {
      await enforceToggle.click();
    }
    await page.getByTestId("org-mfa-factor-totp").click();
    await page.getByTestId("org-mfa-save").click();
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      UPDATED_REGEX,
      { timeout: 10_000 }
    );

    // Reopen: the setting persisted.
    await openOrgSecurityTab(page);
    await expect(page.getByTestId("org-mfa-enforce-toggle")).toHaveAttribute(
      "data-state",
      "checked"
    );
    await expect(page.getByTestId("org-mfa-factor-totp")).toHaveAttribute(
      "data-state",
      "checked"
    );

    // Cleanup: turn enforcement back off so the owner's org is left untouched.
    await page.getByTestId("org-mfa-enforce-toggle").click();
    await page.getByTestId("org-mfa-save").click();
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      UPDATED_REGEX,
      { timeout: 10_000 }
    );
  });

  test("enabling enforcement with no factor is rejected", async ({ page }) => {
    await openOrgSecurityTab(page);

    const enforceToggle = page.getByTestId("org-mfa-enforce-toggle");
    if ((await enforceToggle.getAttribute("data-state")) !== "checked") {
      await enforceToggle.click();
    }
    // Save without selecting a factor -> client blocks with an error toast.
    await page.getByTestId("org-mfa-save").click();
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      NEEDS_FACTOR_REGEX,
      { timeout: 10_000 }
    );
  });
});
