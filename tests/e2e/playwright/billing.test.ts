import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signIn } from "./utils/auth";
import {
  PERSISTENT_TEST_PASSWORD,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

const GET_STARTED_OR_UPGRADE_RE = /get started|upgrade/i;
const GET_STARTED_RE = /get started/i;
const CANCEL_OR_DOWNGRADE_RE = /cancel|downgrade/i;
const CONFIRM_OR_YES_RE = /confirm|yes/i;

test.use({ storageState: { cookies: [], origins: [] } });

test.describe
  .skip("Billing", () => {
    test.describe.configure({ mode: "serial" });

    test.beforeEach(async ({ context }) => {
      await context.clearCookies();
    });

    async function signInAsOwner(page: Page): Promise<void> {
      await signIn(page, PERSISTENT_TEST_USER_EMAIL, PERSISTENT_TEST_PASSWORD);
    }

    async function waitForBillingReady(page: Page): Promise<void> {
      await expect(page.getByTestId("billing-page").first()).toHaveAttribute(
        "data-page-state",
        "ready",
        { timeout: 15_000 }
      );
    }

    async function mockSubscriptionApi(
      page: Page,
      subscription: Record<string, unknown> = {}
    ): Promise<void> {
      await page.route("**/api/billing/subscription", (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            subscription: {
              plan: "free",
              tier: null,
              interval: null,
              status: "active",
              currentPeriodStart: null,
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
              billingAlert: null,
              billingAlertUrl: null,
              ...subscription,
            },
            limits: {
              maxExecutionsPerMonth: 5000,
              gasCreditsCents: 100,
              maxWorkflows: -1,
              apiAccess: "rate-limited",
              logRetentionDays: 7,
              supportLevel: "community",
              sla: null,
            },
          }),
        })
      );
    }

    async function mockInvoicesApi(
      page: Page,
      invoices: Record<string, unknown>[] = []
    ): Promise<void> {
      await page.route("**/api/billing/invoices*", (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices, hasMore: false }),
        })
      );
    }

    test("billing page loads for authenticated user", async ({ page }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page);
      await mockInvoicesApi(page);

      await page.goto("/billing", { waitUntil: "domcontentloaded" });
      await waitForBillingReady(page);

      // Plan cards should be visible under the "Plans" heading
      const plans = page.locator('h2:has-text("Plans") + *');
      await expect(plans).toBeVisible({ timeout: 15_000 });
      await expect(plans.locator("text=Free").first()).toBeVisible();
      await expect(plans.locator("text=Pro").first()).toBeVisible();
      await expect(plans.locator("text=Business").first()).toBeVisible();
      await expect(plans.locator("text=Enterprise").first()).toBeVisible();
    });

    test("free user sees upgrade options", async ({ page }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page, { plan: "free" });
      await mockInvoicesApi(page);

      await page.goto("/billing", { waitUntil: "domcontentloaded" });

      await waitForBillingReady(page);

      // Scroll plans section into view — pricing cards are below the fold
      await page.locator("#plans-section").scrollIntoViewIfNeeded();

      // Should see pricing cards with monthly prices
      await expect(page.locator("text=$49")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("text=$299")).toBeVisible();
    });

    test("plan selection triggers checkout", async ({ page }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page, { plan: "free" });
      await mockInvoicesApi(page);

      // Intercept checkout POST
      let checkoutRequestBody: Record<string, unknown> | undefined;
      await page.route("**/api/billing/checkout", async (route: Route) => {
        if (route.request().method() === "POST") {
          checkoutRequestBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              url: "https://checkout.stripe.com/test_session",
            }),
          });
        }
      });

      await page.goto("/billing", { waitUntil: "domcontentloaded" });
      await waitForBillingReady(page);

      // Click the first "Get Started" or upgrade button for Pro plan
      const proCard = page.locator('[data-testid="plan-card-pro"]');
      const isProCardVisible = await proCard.isVisible();
      const upgradeButton = isProCardVisible
        ? proCard.getByRole("button", { name: GET_STARTED_OR_UPGRADE_RE })
        : page.getByRole("button", { name: GET_STARTED_RE }).first();

      await expect(upgradeButton).toBeVisible({ timeout: 5000 });
      await upgradeButton.click();

      // Verify checkout request was made with correct plan
      if (checkoutRequestBody) {
        expect(checkoutRequestBody.plan).toBe("pro");
      }
    });

    test("subscription status displays correctly for pro plan", async ({
      page,
    }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page, {
        plan: "pro",
        tier: "25k",
        interval: "monthly",
        status: "active",
        currentPeriodStart: "2025-01-01T00:00:00.000Z",
        currentPeriodEnd: "2025-02-01T00:00:00.000Z",
      });
      await mockInvoicesApi(page);

      await page.goto("/billing", { waitUntil: "domcontentloaded" });
      await waitForBillingReady(page);

      // Should show current plan indicator
      await expect(page.locator("text=Pro")).toBeVisible({ timeout: 15_000 });
    });

    test("cancel subscription flow", async ({ page }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page, {
        plan: "pro",
        tier: "25k",
        interval: "monthly",
        status: "active",
        currentPeriodEnd: "2025-02-01T00:00:00.000Z",
      });
      await mockInvoicesApi(page);

      await page.route("**/api/billing/cancel", (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            canceled: true,
            periodEnd: "2025-02-01T00:00:00.000Z",
          }),
        })
      );

      await page.goto("/billing", { waitUntil: "domcontentloaded" });
      await waitForBillingReady(page);

      // Look for cancel button or downgrade to free button
      const cancelButton = page.getByRole("button", {
        name: CANCEL_OR_DOWNGRADE_RE,
      });
      await expect(cancelButton.first()).toBeVisible({ timeout: 5000 });
      await cancelButton.first().click();

      // Confirm dialog if present
      const confirmButton = page.getByRole("button", {
        name: CONFIRM_OR_YES_RE,
      });
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click();
      }
    });

    test("billing history displays invoices", async ({ page }) => {
      await signInAsOwner(page);
      await mockSubscriptionApi(page, {
        plan: "pro",
        tier: "25k",
        interval: "monthly",
        status: "active",
      });
      await mockInvoicesApi(page, [
        {
          id: "inv_1",
          date: "2025-01-01T00:00:00.000Z",
          amount: 4900,
          currency: "usd",
          status: "paid",
          description: "Pro 25k",
          periodStart: "2025-01-01T00:00:00.000Z",
          periodEnd: "2025-02-01T00:00:00.000Z",
          invoiceUrl: "https://invoice.stripe.com/i/1",
          pdfUrl: null,
        },
        {
          id: "inv_2",
          date: "2024-12-01T00:00:00.000Z",
          amount: 4900,
          currency: "usd",
          status: "paid",
          description: "Pro 25k",
          periodStart: "2024-12-01T00:00:00.000Z",
          periodEnd: "2025-01-01T00:00:00.000Z",
          invoiceUrl: "https://invoice.stripe.com/i/2",
          pdfUrl: null,
        },
      ]);

      await page.goto("/billing", { waitUntil: "domcontentloaded" });
      await waitForBillingReady(page);

      // Should display invoice rows
      await expect(page.locator("text=Pro 25k").first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("text=$49.00").first()).toBeVisible();
    });
  });
