import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

// This month's label, "Oct 1, 2026 - Oct 31, 2026": wider than any preset.
const MONTH_RANGE_REGEX = /^\w{3} 1, \d{4} - \w{3} \d{2}, \d{4}$/;

export function customButton(page: Page): Locator {
  return page.getByRole("button", { name: "Custom date range" });
}

export function rangeNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Time range" });
}

export async function pickThisMonth(page: Page): Promise<void> {
  await customButton(page).click();
  await page.getByRole("button", { name: "This month" }).click();
  await page.keyboard.press("Escape");
  await expect(customButton(page)).toHaveText(MONTH_RANGE_REGEX);
}
