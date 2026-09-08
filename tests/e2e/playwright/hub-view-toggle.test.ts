import { expect, test } from "./fixtures";

// Force a fresh anonymous context so cookie state starts empty for every
// test in this file. The view toggle must work for anonymous users too.
test.use({ storageState: { cookies: [], origins: [] } });

// Phase 44 plan 44-01 made `/hub` default to the Protocols tab, where the
// view toggle does not render. The toggle lives in the Workflows tab, so
// every test in this file targets `/hub?tab=workflows` explicitly.
const WORKFLOWS_TAB_URL = "/hub?tab=workflows";

test.describe("Hub view toggle persistence (HUB-22)", () => {
  test.beforeEach(async ({ context }) => {
    // Belt-and-braces: even though storageState above resets browser state,
    // explicitly clearing cookies guards against any cross-test bleed within
    // the same worker.
    await context.clearCookies();
  });

  test("defaults to cards view on first visit (no cookie)", async ({
    page,
  }) => {
    await page.goto(WORKFLOWS_TAB_URL, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-view-mode="cards"]')).toBeVisible({
      timeout: 15_000,
    });
    const cardsRadio = page.getByRole("radio", { name: "View as cards" });
    await expect(cardsRadio).toHaveAttribute("aria-checked", "true");
  });

  test("switches to list view on click and persists across reload", async ({
    page,
    context,
  }) => {
    await page.goto(WORKFLOWS_TAB_URL, { waitUntil: "domcontentloaded" });

    const listRadio = page.getByRole("radio", { name: "View as list" });
    await expect(listRadio).toBeVisible({ timeout: 15_000 });
    await listRadio.click();

    // Optimistic UI update should swap the wrapper attribute synchronously.
    await expect(page.locator('[data-view-mode="list"]')).toBeVisible();
    await expect(listRadio).toHaveAttribute("aria-checked", "true");

    // Cookie should now be hub_view=list. The fetch is fire-and-forget;
    // poll briefly for the cookie to land.
    await expect
      .poll(
        async () => {
          const cookies = await context.cookies();
          return cookies.find((c) => c.name === "hub_view")?.value ?? null;
        },
        { timeout: 5000 }
      )
      .toBe("list");

    // Reload — first paint must be list (cookie-driven, no client flip).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-view-mode="list"]')).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "View as list" })
    ).toHaveAttribute("aria-checked", "true");
  });

  test("toggle back to cards persists across reload", async ({
    page,
    context,
  }) => {
    // Start on the workflows tab, switch to list, then back to cards.
    await page.goto(WORKFLOWS_TAB_URL, { waitUntil: "domcontentloaded" });
    const listRadio = page.getByRole("radio", { name: "View as list" });
    await expect(listRadio).toBeVisible({ timeout: 15_000 });
    await listRadio.click();
    await expect(page.locator('[data-view-mode="list"]')).toBeVisible();

    await page.getByRole("radio", { name: "View as cards" }).click();
    await expect(page.locator('[data-view-mode="cards"]')).toBeVisible();

    await expect
      .poll(
        async () => {
          const cookies = await context.cookies();
          return cookies.find((c) => c.name === "hub_view")?.value ?? null;
        },
        { timeout: 5000 }
      )
      .toBe("cards");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-view-mode="cards"]')).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "View as cards" })
    ).toHaveAttribute("aria-checked", "true");
  });

  test("keyboard navigation cycles between options", async ({ page }) => {
    await page.goto(WORKFLOWS_TAB_URL, { waitUntil: "domcontentloaded" });
    const cardsRadio = page.getByRole("radio", { name: "View as cards" });
    await expect(cardsRadio).toBeVisible({ timeout: 15_000 });
    await cardsRadio.focus();

    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("radio", { name: "View as list" })
    ).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-view-mode="list"]')).toBeVisible();

    await page.keyboard.press("ArrowLeft");
    await expect(cardsRadio).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-view-mode="cards"]')).toBeVisible();
  });
});
