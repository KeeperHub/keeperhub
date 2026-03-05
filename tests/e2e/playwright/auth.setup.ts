import { expect, test as setup } from "@playwright/test";
import { signIn } from "./utils/auth";
import {
  PERSISTENT_BYSTANDER_EMAIL,
  PERSISTENT_INVITER_EMAIL,
  PERSISTENT_TEST_PASSWORD,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";

const authDir = "tests/e2e/playwright/.auth";

setup("authenticate as persistent test user", async ({ page }) => {
  await signIn(page, PERSISTENT_TEST_USER_EMAIL, PERSISTENT_TEST_PASSWORD);
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.context().storageState({ path: `${authDir}/user.json` });
});

setup("authenticate as inviter", async ({ page }) => {
  await signIn(page, PERSISTENT_INVITER_EMAIL, PERSISTENT_TEST_PASSWORD);
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.context().storageState({ path: `${authDir}/inviter.json` });
});

setup("authenticate as bystander", async ({ page }) => {
  await signIn(page, PERSISTENT_BYSTANDER_EMAIL, PERSISTENT_TEST_PASSWORD);
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator('button[role="combobox"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.context().storageState({ path: `${authDir}/bystander.json` });
});
