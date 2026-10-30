import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { textContrast } from "./utils/contrast";
import {
  createTestPublicTag,
  createTestWorkflow,
  deleteTestPublicTag,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import {
  type Box,
  box,
  dismissPhoneOverlays,
  overlaps,
  textFits,
} from "./utils/layout";

// The Hub is public; these checks are about what a visitor sees, with the
// nav as a first visit leaves it. Each test loads its page once and steps
// through the widths.
test.use({ storageState: { cookies: [], origins: [] } });

const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const TABLET_WIDTHS = [640, 768, 900] as const;
const HEIGHT = 844;

const middle = (b: Box): number => b.y + b.height / 2;
const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;

async function open(page: Page, width: number, path: string): Promise<void> {
  await dismissPhoneOverlays(page);
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

// Resizing can re-render the nav beside the page, so each width's checks
// retry until the layout has settled.
async function atWidth(
  page: Page,
  width: number,
  check: () => Promise<void>
): Promise<void> {
  await test.step(`${width}px`, async () => {
    await page.setViewportSize({ width, height: HEIGHT });
    await expect(check).toPass({ timeout: 10_000 });
  });
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
  const [search, tabs, demos, docs] = await Promise.all([
    box(band.search),
    box(band.tabs),
    box(band.demos),
    box(band.docs),
  ]);
  return { search, tabs, demos, docs };
}

async function tabOrder(page: Page): Promise<string[]> {
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
  return names;
}

test.describe("Hub tab band", () => {
  test("phones and tablets: search and links share a row, the tabs take the next", async ({
    page,
  }) => {
    await open(page, PHONE_WIDTHS[0], "/hub");
    const band = tabBand(page);
    await expect(band.tabs).toBeVisible({ timeout: 15_000 });

    for (const width of [...PHONE_WIDTHS, ...TABLET_WIDTHS]) {
      await atWidth(page, width, async () => {
        const b = await bandBoxes(page);
        expect(await overlaps(b.search, b.demos)).toBe(false);
        expect(await overlaps(b.demos, b.docs)).toBe(false);
        expect(Math.abs(middle(b.demos) - middle(b.search))).toBeLessThan(2);
        expect(right(b.docs)).toBeLessThanOrEqual(width);
        expect(b.tabs.y).toBeGreaterThanOrEqual(bottom(b.search));
        expect(right(b.tabs)).toBeLessThanOrEqual(width);
        const tabs = await band.tabs.getByRole("tab").all();
        expect(tabs).toHaveLength(3);
        for (const tab of tabs) {
          expect(await textFits(tab)).toBe(true);
        }
        if ((PHONE_WIDTHS as readonly number[]).includes(width)) {
          const widths = await Promise.all(
            tabs.map(async (tab) => (await box(tab)).width)
          );
          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(
            1
          );
        }
      });
    }
  });

  test("the active tab's longer label still fits at 320px", async ({
    page,
  }) => {
    await open(page, 320, "/hub?tab=marketplace");
    const active = page.getByRole("tab", { name: "Marketplace" });
    await expect(active).toHaveAttribute("data-state", "active", {
      timeout: 15_000,
    });
    expect(await textFits(active)).toBe(true);
  });

  // The links are rendered before and after the tabs and only the copy for
  // the layout shows, so Tab follows the DOM in every browser. getByRole
  // skips the hidden copy; a second visible one would fail strict mode.
  test("Tab follows the rows as drawn at 390px", async ({ page }) => {
    await open(page, 390, "/hub");
    expect(await tabOrder(page)).toEqual(["Demos", "Docs", "Protocols"]);
  });

  test("desktop: one row, and Tab still reaches the tabs first", async ({
    page,
  }) => {
    await open(page, 1280, "/hub");
    await expect(tabBand(page).tabs).toBeVisible({ timeout: 15_000 });
    for (const width of [1024, 1280]) {
      await atWidth(page, width, async () => {
        const b = await bandBoxes(page);
        expect(Math.abs(middle(b.tabs) - middle(b.search))).toBeLessThan(2);
        expect(Math.abs(middle(b.demos) - middle(b.search))).toBeLessThan(2);
        expect(b.tabs.x).toBeGreaterThan(right(b.search));
        expect(b.demos.x).toBeGreaterThan(right(b.tabs));
      });
    }
    expect(await tabOrder(page)).toEqual(["Protocols", "Demos", "Docs"]);
  });
});

test.describe("Tab band text", () => {
  // WCAG AA for body text; the links and the tabs not picked used to sit
  // at 2.7:1 and 3.7:1 and read as disabled.
  const READABLE = 4.5;

  test("Demos, Docs and the tabs not picked are readable", async ({ page }) => {
    await open(page, 1280, "/hub");
    const band = tabBand(page);
    await expect(band.tabs).toBeVisible({ timeout: 15_000 });
    for (const width of [...PHONE_WIDTHS, ...TABLET_WIDTHS, 1024, 1280]) {
      await atWidth(page, width, async () => {
        for (const link of [band.demos, band.docs]) {
          expect(await textContrast(link)).toBeGreaterThanOrEqual(READABLE);
        }
        for (const name of ["Workflows", "Marketplace"]) {
          const tab = band.tabs.getByRole("tab", { name });
          await expect(tab).toHaveAttribute("data-state", "inactive");
          expect(await textContrast(tab)).toBeGreaterThanOrEqual(READABLE);
        }
      });
    }
  });

  test("hovering a tab not picked brightens its text", async ({ page }) => {
    await open(page, 1280, "/hub");
    const tab = tabBand(page).tabs.getByRole("tab", { name: "Workflows" });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    const resting = await textContrast(tab);
    await tab.hover();
    await expect(async () => {
      expect(await textContrast(tab)).toBeGreaterThan(resting + 1);
    }).toPass({ timeout: 5000 });
  });

  test("Demos takes the tabs' keyboard focus ring", async ({ page }) => {
    await open(page, 1280, "/hub");
    expect(await tabOrder(page)).toEqual(["Protocols", "Demos", "Docs"]);
    const ring = (locator: Locator): Promise<string[]> =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.getPropertyValue("--tw-ring-color"), style.boxShadow];
      });
    const band = tabBand(page);
    const protocols = band.tabs.getByRole("tab", { name: "Protocols" });
    await protocols.focus();
    await page.keyboard.press("Tab");
    await expect(band.demos).toBeFocused();
    const [demosColor, demosShadow] = await ring(band.demos);
    await page.keyboard.press("Shift+Tab");
    await expect(protocols).toBeFocused();
    const [tabColor] = await ring(protocols);
    expect(demosColor).not.toBe("");
    expect(demosColor).toBe(tabColor);
    expect(demosShadow).not.toBe("none");
  });
});

test.describe("Marketplace leaderboard columns", () => {
  // Unique per run so ?q= shows only these listings. The second price is
  // the widest label the narrow price column has to hold.
  const token = `hublayout${Date.now()}`;
  const listings = [
    {
      name: `${token} marketplace service with a name long enough to be cut short`,
      slug: `${token}-a`,
      price: "0.25",
      label: "$0.25/call",
    },
    {
      name: `${token} pricey service`,
      slug: `${token}-b`,
      price: "1000",
      label: "$1000.00/call",
    },
  ] as const;
  const workflowIds: string[] = [];

  test.beforeAll(async () => {
    for (const listing of listings) {
      const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name: listing.name,
        listing: { slug: listing.slug, priceUsdcPerCall: listing.price },
      });
      workflowIds.push(workflow.id);
    }
  });

  test.afterAll(async () => {
    for (const id of workflowIds) {
      await deleteTestWorkflow(id);
    }
  });

  const rowOf = (page: Page, name: string): Locator =>
    page.getByRole("row", { name: `Open ${name}` });

  // 1024px is the narrowest table: the nav and the sort sidebar both show.
  test("names and prices are readable and line up from 320 to 1280px", async ({
    page,
  }) => {
    await open(page, 320, `/hub?tab=marketplace&q=${token}`);
    await expect(rowOf(page, listings[1].name)).toBeVisible({
      timeout: 15_000,
    });

    for (const width of [320, 390, 768, 1024, 1280]) {
      await atWidth(page, width, async () => {
        const header = await box(
          page.getByRole("columnheader", { name: "Price" })
        );
        for (const listing of listings) {
          const row = rowOf(page, listing.name);
          const [rowBox, nameBox, priceBox] = await Promise.all([
            box(row),
            box(row.getByText(listing.name)),
            box(row.getByText(listing.label)),
          ]);
          // The name shares its cell with the copy-slug button; at 320px
          // the room kept for a four-figure price leaves it about 72px.
          expect(nameBox.width).toBeGreaterThanOrEqual(64);
          expect(await overlaps(nameBox, priceBox)).toBe(false);
          expect(right(priceBox)).toBeLessThanOrEqual(right(rowBox));
          expect(Math.abs(right(header) - right(priceBox))).toBeLessThanOrEqual(
            1
          );
        }
      });
    }
  });

  test("a narrow table puts the call count under the price; 1280px shows every column", async ({
    page,
  }) => {
    await open(page, 390, `/hub?tab=marketplace&q=${token}`);
    const row = rowOf(page, listings[0].name);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("0 calls")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Calls" })
    ).toBeHidden();

    await page.setViewportSize({ width: 1280, height: HEIGHT });
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

test.describe("Workflows list columns", () => {
  // Unique per run so ?q= shows only these templates.
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const token = `hublist${suffix}`;
  const featured = `${token} rebalance collateral across chains when the health factor drops`;
  const plain = `${token} wrap stETH`;
  // A row shows up to three tags on one line. Long real names plus the run
  // suffix, so the tags are new rows that only this test deletes.
  const tagNames = ["Cross-chain Bridges", "Liquidations", "Monitoring"].map(
    (name) => `${name} ${suffix}`
  );
  // Counts injected into the feed: seven digits, and the widest compact label.
  const uses = new Map([
    [featured, { count: 1_234_567, label: "1.2M" }],
    [plain, { count: 999_949, label: "999.9K" }],
  ]);
  const workflowIds: string[] = [];
  const tagIds: string[] = [];

  test.beforeAll(async () => {
    for (const name of tagNames) {
      tagIds.push(await createTestPublicTag(name));
    }
    for (const [name, isFeatured] of [
      [featured, true],
      [plain, false],
    ] as const) {
      const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name,
        hub: { featured: isFeatured, tagIds },
      });
      workflowIds.push(workflow.id);
    }
  });

  test.afterAll(async () => {
    for (const id of workflowIds) {
      await deleteTestWorkflow(id);
    }
    for (const id of tagIds) {
      await deleteTestPublicTag(id);
    }
  });

  const rowOf = (page: Page, name: string): Locator =>
    page.getByRole("row", { name: `Open ${name} preview` });
  const header = (page: Page, name: string): Locator =>
    page.getByRole("columnheader", { name, exact: true });
  const badgeOf = (row: Locator): Locator =>
    row.getByText("Featured", { exact: true });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  async function openList(page: Page, width: number): Promise<void> {
    await page.route("**/api/workflows/public*", async (route) => {
      const response = await route.fetch();
      const feed: unknown = await response.json();
      // An error body passes through so the test shows the real failure.
      if (!Array.isArray(feed)) {
        await route.fulfill({ response });
        return;
      }
      for (const workflow of feed as {
        name: string;
        duplicateCount: number;
      }[]) {
        const injected = uses.get(workflow.name);
        if (injected) {
          workflow.duplicateCount = injected.count;
        }
      }
      await route.fulfill({ response, json: feed });
    });
    await open(page, width, `/hub?tab=workflows&q=${token}`);
    await page.getByRole("radio", { name: "View as list" }).click();
    await expect(rowOf(page, plain)).toBeVisible({ timeout: 15_000 });
  }

  // Whether a tap dx px left (dx < 0) or right of the button lands on it.
  async function tapAreaHits(button: Locator, dx: number): Promise<boolean> {
    return await button.evaluate((element, offset) => {
      const rect = element.getBoundingClientRect();
      const x = offset < 0 ? rect.left + offset : rect.right + offset;
      const hit = document.elementFromPoint(x, rect.top + rect.height / 2);
      return hit !== null && element.contains(hit);
    }, dx);
  }

  // 1024px is the narrowest table: the nav and the sort sidebar both show.
  test("names, uses and votes are readable and line up from 320 to 1920px", async ({
    page,
  }) => {
    await openList(page, 320);
    for (const width of [320, 390, 768, 900, 1024, 1280, 1440, 1920]) {
      await atWidth(page, width, async () => {
        const [usesHeader, votes] = await Promise.all([
          box(header(page, "Uses")),
          box(header(page, "Votes")),
        ]);
        for (const name of [featured, plain]) {
          const row = rowOf(page, name);
          const [rowBox, nameBox, downBox] = await Promise.all([
            box(row),
            box(row.getByText(name)),
            box(row.getByRole("button", { name: "Downvote" })),
          ]);
          // 6rem: before the narrow tier dropped the icon, 320px left 78px.
          expect(nameBox.width).toBeGreaterThanOrEqual(96);
          expect(right(nameBox)).toBeLessThanOrEqual(usesHeader.x);
          expect(right(rowBox)).toBeLessThanOrEqual(width);
          expect(right(downBox)).toBeLessThanOrEqual(right(rowBox));
          expect(Math.abs(right(votes) - right(downBox))).toBeLessThanOrEqual(
            1
          );
        }
        // Each count stays inside the Uses track.
        for (const [name, { label }] of uses) {
          const row = rowOf(page, name);
          const [count, nameBox] = await Promise.all([
            box(row.getByText(label, { exact: true })),
            box(row.getByText(name)),
          ]);
          expect(count.x).toBeGreaterThanOrEqual(right(nameBox));
          expect(count.x).toBeGreaterThanOrEqual(usesHeader.x - 1);
          expect(right(count)).toBeLessThanOrEqual(right(usesHeader) + 1);
        }
      });
    }
  });

  test("the vote buttons take taps 5px outside, but a tap on the score opens the preview", async ({
    page,
  }) => {
    await openList(page, 320);
    const row = rowOf(page, plain);
    const up = row.getByRole("button", { name: "Upvote" });
    const down = row.getByRole("button", { name: "Downvote" });
    for (const width of [320, 1280]) {
      await atWidth(page, width, async () => {
        expect(await tapAreaHits(up, -5)).toBe(true);
        expect(await tapAreaHits(down, 5)).toBe(true);
        // 1px into the score from either side, past the 2px gap.
        expect(await tapAreaHits(up, 3)).toBe(false);
        expect(await tapAreaHits(down, -3)).toBe(false);
      });
    }
    const upBox = await box(up);
    await page.mouse.click(right(upBox) + 3, middle(upBox));
    await expect(page).toHaveURL(new RegExp(`/workflows/${workflowIds[1]}`));
  });

  test("a narrow table puts Featured under the name; wider ones give it and the tags columns", async ({
    page,
  }) => {
    await openList(page, 390);
    const row = rowOf(page, featured);
    const name = row.getByText(featured);
    const tag = row.getByText(tagNames[0], { exact: true });

    await atWidth(page, 390, async () => {
      const [nameBox, badgeBox] = await Promise.all([
        box(name),
        box(badgeOf(row)),
      ]);
      expect(badgeBox.y).toBeGreaterThanOrEqual(bottom(nameBox));
      await expect(header(page, "Tags")).toBeHidden();
      await expect(tag).toBeHidden();
    });

    // 900px has the badge column only, 1280px the compact Tags column and
    // 1920px the original grid.
    await atWidth(page, 900, async () => {
      const [nameBox, badgeBox, downBox] = await Promise.all([
        box(name),
        box(badgeOf(row)),
        box(row.getByRole("button", { name: "Downvote" })),
      ]);
      expect(badgeBox.x).toBeGreaterThan(right(downBox));
      expect(Math.abs(middle(badgeBox) - middle(nameBox))).toBeLessThan(2);
      await expect(header(page, "Tags")).toBeHidden();
    });

    for (const width of [1280, 1920]) {
      await atWidth(page, width, async () => {
        const [nameBox, badgeBox, downBox, tagBox] = await Promise.all([
          box(name),
          box(badgeOf(row)),
          box(row.getByRole("button", { name: "Downvote" })),
          box(tag),
        ]);
        expect(badgeBox.x).toBeGreaterThan(right(downBox));
        expect(Math.abs(middle(badgeBox) - middle(nameBox))).toBeLessThan(2);
        expect(tagBox.x).toBeGreaterThan(right(nameBox));
        const [tags, usesHeader] = await Promise.all([
          box(header(page, "Tags")),
          box(header(page, "Uses")),
        ]);
        expect(Math.abs(tagBox.x - tags.x)).toBeLessThanOrEqual(1);
        // Long names shorten: one line, all inside the Tags track.
        const chips = await Promise.all(
          tagNames.map((tagName) =>
            box(row.getByText(tagName, { exact: true }))
          )
        );
        const tops = chips.map((chip) => chip.y);
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
        expect(Math.max(...chips.map(right))).toBeLessThanOrEqual(usesHeader.x);
      });
    }
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
      title: "Pool Reserves Synced",
      action: "Listen to Event",
    },
  ] as const;

  async function openPopup(
    page: Page,
    item: (typeof cases)[number]
  ): Promise<{ dialog: Locator; title: Locator; action: Locator }> {
    await open(page, 320, `/hub?tab=protocols&protocol=${item.protocol}`);
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

  for (const item of cases) {
    test(`${item.action} sits under its text at full width on phones, beside it on desktop (${item.protocol})`, async ({
      page,
    }) => {
      const { dialog, title, action } = await openPopup(page, item);
      for (const width of [320, 390]) {
        await atWidth(page, width, async () => {
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
      await atWidth(page, 1280, async () => {
        const [titleBox, actionBox] = await Promise.all([
          box(title),
          box(action),
        ]);
        expect(actionBox.x).toBeGreaterThan(right(titleBox));
      });
    });
  }

  test("the close button is a 44px target clear of the title on phones", async ({
    page,
  }) => {
    const { dialog } = await openPopup(page, cases[0]);
    const close = dialog.getByRole("button", { name: "Close" });
    // The first "Aave V3" heading is the dialog's screen-reader title.
    const heading = dialog.getByRole("heading", { name: "Aave V3" }).last();
    for (const width of [320, 390]) {
      await atWidth(page, width, async () => {
        const closeBox = await box(close);
        expect(closeBox.width).toBeGreaterThanOrEqual(44);
        expect(closeBox.height).toBeGreaterThanOrEqual(44);
        expect(await overlaps(closeBox, heading)).toBe(false);
        expect(
          await overlaps(closeBox, dialog.getByTitle("View on explorer"))
        ).toBe(false);
      });
    }
  });
});
