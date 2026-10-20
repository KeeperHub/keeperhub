import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { box, dismissPhoneOverlays, overlaps, textFits } from "./utils/layout";

// The Hub is public; these checks are about what a visitor sees, with the
// nav as a first visit leaves it.
test.use({ storageState: { cookies: [], origins: [] } });

const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const TABLET_WIDTHS = [640, 768, 900] as const;
const HEIGHT = 844;

type Box = { x: number; y: number; width: number; height: number };

const middle = (b: Box): number => b.y + b.height / 2;
const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;

async function openAt(page: Page, width: number, path: string): Promise<void> {
  await dismissPhoneOverlays(page);
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

function tabBand(page: Page): {
  search: Locator;
  tabs: Locator;
  demos: Locator;
  docs: Locator;
} {
  return {
    search: page.getByTestId("hub-tab-search"),
    tabs: page.getByRole("tablist", { name: "Hub views" }),
    demos: page.getByRole("link", { name: "Demos", exact: true }),
    docs: page.getByRole("link", { name: "Docs", exact: true }),
  };
}

async function bandBoxes(
  page: Page
): Promise<{ search: Box; tabs: Box; demos: Box; docs: Box }> {
  const band = tabBand(page);
  await expect(band.tabs).toBeVisible({ timeout: 15_000 });
  const [search, tabs, demos, docs] = await Promise.all([
    box(band.search),
    box(band.tabs),
    box(band.demos),
    box(band.docs),
  ]);
  return { search, tabs, demos, docs };
}

test.describe("Hub tab band", () => {
  for (const width of [...PHONE_WIDTHS, ...TABLET_WIDTHS]) {
    test(`search and links share a row and the tabs take the next at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width, "/hub");
      const band = tabBand(page);
      const b = await bandBoxes(page);

      expect(await overlaps(band.search, band.demos)).toBe(false);
      expect(await overlaps(band.demos, band.docs)).toBe(false);
      expect(Math.abs(middle(b.demos) - middle(b.search))).toBeLessThan(2);
      expect(right(b.docs)).toBeLessThanOrEqual(width);
      expect(b.tabs.y).toBeGreaterThanOrEqual(bottom(b.search));
      expect(right(b.tabs)).toBeLessThanOrEqual(width);
      for (const tab of await band.tabs.getByRole("tab").all()) {
        expect(await textFits(tab)).toBe(true);
      }
    });
  }

  for (const width of PHONE_WIDTHS) {
    test(`the tabs share the row equally at ${width}px`, async ({ page }) => {
      await openAt(page, width, "/hub");
      const { tabs } = tabBand(page);
      await expect(tabs).toBeVisible({ timeout: 15_000 });
      const widths: number[] = [];
      for (const tab of await tabs.getByRole("tab").all()) {
        widths.push((await box(tab)).width);
      }
      expect(widths).toHaveLength(3);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });
  }

  test("the active tab's longer label still fits at 320px", async ({
    page,
  }) => {
    await openAt(page, 320, "/hub?tab=marketplace");
    const active = page.getByRole("tab", { name: "Marketplace" });
    await expect(active).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
    expect(await textFits(active)).toBe(true);
  });

  // Chromium follows reading-flow; browsers without it keep DOM order
  // (search, tabs, links).
  test("Tab follows the rows as drawn at 390px", async ({ page }) => {
    await openAt(page, 390, "/hub");
    // Until the tabs hydrate, focus cannot move into them.
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Search the active tab").focus();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      names.push(
        await page.evaluate(
          () => document.activeElement?.textContent?.trim() ?? ""
        )
      );
    }
    expect(names).toEqual(["Demos", "Docs", "Protocols"]);
  });

  for (const width of [1024, 1280] as const) {
    test(`search, tabs and links share one row at ${width}px`, async ({
      page,
    }) => {
      await openAt(page, width, "/hub");
      const b = await bandBoxes(page);
      expect(Math.abs(middle(b.tabs) - middle(b.search))).toBeLessThan(2);
      expect(Math.abs(middle(b.demos) - middle(b.search))).toBeLessThan(2);
      expect(b.tabs.x).toBeGreaterThan(right(b.search));
      expect(b.demos.x).toBeGreaterThan(right(b.tabs));
    });
  }
});

test.describe("Marketplace leaderboard columns", () => {
  // Unique per run so ?q= shows only this listing.
  const token = `hublayout${Date.now()}`;
  const name = `${token} marketplace service with a name long enough to be cut short`;
  let workflowId: string | undefined;

  test.beforeAll(async () => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name,
      listing: { slug: token, priceUsdcPerCall: "0.25" },
    });
    workflowId = workflow.id;
  });

  test.afterAll(async () => {
    if (workflowId) {
      await deleteTestWorkflow(workflowId);
    }
  });

  async function openRow(page: Page, width: number): Promise<Locator> {
    await openAt(page, width, `/hub?tab=marketplace&q=${token}`);
    const row = page.getByRole("row", { name: `Open ${name}` });
    await expect(row).toBeVisible({ timeout: 15_000 });
    return row;
  }

  // 1024px is the narrowest table: the nav and the sort sidebar both show.
  for (const width of [320, 390, 768, 1024, 1280] as const) {
    test(`name and price are readable and line up at ${width}px`, async ({
      page,
    }) => {
      const row = await openRow(page, width);
      const nameText = row.getByText(name);
      const price = row.getByText("$0.25/call");
      const [rowBox, nameBox, priceBox, header] = await Promise.all([
        box(row),
        box(nameText),
        box(price),
        box(page.getByRole("columnheader", { name: "Price" })),
      ]);

      // The name shares its cell with the copy-slug button.
      expect(nameBox.width).toBeGreaterThanOrEqual(80);
      expect(await overlaps(nameText, price)).toBe(false);
      expect(right(priceBox)).toBeLessThanOrEqual(right(rowBox));
      expect(Math.abs(right(header) - right(priceBox))).toBeLessThanOrEqual(1);
    });
  }

  test("a narrow table puts the call count under the price at 390px", async ({
    page,
  }) => {
    const row = await openRow(page, 390);
    await expect(row.getByText("0 calls")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Calls" })
    ).toBeHidden();
  });

  test("every column shows at 1280px", async ({ page }) => {
    const row = await openRow(page, 1280);
    for (const column of [
      "Rank",
      "Name",
      "Tags",
      "Owner",
      "Calls",
      "Price",
      "Chain",
    ]) {
      await expect(
        page.getByRole("columnheader", { name: column })
      ).toBeVisible();
    }
    await expect(row.getByText("0 calls")).toBeHidden();
  });
});

test.describe("Protocol popup rows", () => {
  const cases = [
    {
      protocol: "aave-v3",
      tab: null,
      title: "Supply Asset",
      action: "Use in Workflow",
    },
    {
      protocol: "aerodrome",
      tab: "Events",
      title: "Gauge Vote Cast",
      action: "Listen to Event",
    },
  ] as const;

  async function openPopup(
    page: Page,
    width: number,
    item: (typeof cases)[number]
  ): Promise<{ dialog: Locator; title: Locator; action: Locator }> {
    await openAt(page, width, `/hub?tab=protocols&protocol=${item.protocol}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // It zooms in from 95%: measure once the animation is over.
    await dialog.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished)
      )
    );
    if (item.tab) {
      await dialog
        .getByRole("tab", { name: new RegExp(`^${item.tab}`) })
        .click();
    }
    const title = dialog.getByText(item.title, { exact: true });
    // The innermost element holding both is the title's own row.
    const action = dialog
      .locator("div")
      .filter({ has: page.getByText(item.title, { exact: true }) })
      .filter({ has: page.getByRole("button", { name: item.action }) })
      .last()
      .getByRole("button", { name: item.action });
    await expect(action).toBeVisible();
    return { dialog, title, action };
  }

  for (const width of [320, 390] as const) {
    for (const item of cases) {
      test(`${item.action} sits under its text at full width at ${width}px (${item.protocol})`, async ({
        page,
      }) => {
        const { dialog, title, action } = await openPopup(page, width, item);
        const [dialogBox, titleBox, actionBox] = await Promise.all([
          box(dialog),
          box(title),
          box(action),
        ]);
        expect(actionBox.y).toBeGreaterThanOrEqual(bottom(titleBox));
        expect(actionBox.height).toBeGreaterThanOrEqual(44);
        // Full width: it starts where the text does and spans the popup
        // but for its padding.
        expect(Math.abs(actionBox.x - titleBox.x)).toBeLessThanOrEqual(1);
        expect(actionBox.width).toBeGreaterThan(dialogBox.width * 0.85);
        expect(dialogBox.x).toBeGreaterThan(0);
        expect(right(dialogBox)).toBeLessThan(width);
      });
    }

    test(`the close button is a 44px target clear of the title at ${width}px`, async ({
      page,
    }) => {
      const { dialog } = await openPopup(page, width, cases[0]);
      const close = dialog.getByRole("button", { name: "Close" });
      const closeBox = await box(close);
      expect(closeBox.width).toBeGreaterThanOrEqual(44);
      expect(closeBox.height).toBeGreaterThanOrEqual(44);
      // The first "Aave V3" heading is the dialog's screen-reader title.
      const heading = dialog.getByRole("heading", { name: "Aave V3" }).last();
      expect(await overlaps(close, heading)).toBe(false);
      expect(await overlaps(close, dialog.getByTitle("View on explorer"))).toBe(
        false
      );
    });
  }

  test("at 1280px the button stays beside its text", async ({ page }) => {
    const { title, action } = await openPopup(page, 1280, cases[0]);
    const [titleBox, actionBox] = await Promise.all([box(title), box(action)]);
    expect(actionBox.x).toBeGreaterThan(right(titleBox));
  });
});
