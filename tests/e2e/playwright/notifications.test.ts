import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { signIn } from "./utils/auth";
import {
  PERSISTENT_TEST_PASSWORD,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

type NotificationStatus = {
  unreadCount: number;
  types: string[];
};

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Notifications dot", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  async function mockNotificationsStatus(
    page: Page,
    status: NotificationStatus
  ): Promise<void> {
    await page.route("**/api/notifications/status", (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(status),
      })
    );
  }

  test("shows red dot on avatar and Billing item when billing limit reached", async ({
    page,
  }) => {
    await mockNotificationsStatus(page, {
      unreadCount: 1,
      types: ["billing_limit_reached"],
    });

    await signIn(page, PERSISTENT_TEST_USER_EMAIL, PERSISTENT_TEST_PASSWORD);

    const avatarDot = page.getByTestId("user-menu-notification-dot");
    await expect(avatarDot).toBeVisible({ timeout: 10_000 });

    await page.screenshot({
      path: "tests/e2e/playwright/.probes/notifications-avatar-dot.png",
      fullPage: false,
    });

    await page.getByTestId("user-menu").click();

    const billingDot = page.getByTestId("billing-notification-dot");
    await expect(billingDot).toBeVisible({ timeout: 5000 });

    await page.screenshot({
      path: "tests/e2e/playwright/.probes/notifications-billing-dot.png",
      fullPage: false,
    });
  });

  test("hides dots when no notifications are present", async ({ page }) => {
    await mockNotificationsStatus(page, { unreadCount: 0, types: [] });

    await signIn(page, PERSISTENT_TEST_USER_EMAIL, PERSISTENT_TEST_PASSWORD);

    await expect(page.getByTestId("user-menu-notification-dot")).toHaveCount(0);

    await page.getByTestId("user-menu").click();

    await expect(page.getByTestId("billing-notification-dot")).toHaveCount(0);
  });
});
