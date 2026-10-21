import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  type Box,
  box,
  dismissPhoneOverlays,
  overlaps,
  textFits,
} from "./utils/layout";

// The activity feed's layout on phones, and that nothing about it changes from
// 640px up. The feed is served from a stub so every width sees the same rows,
// including the long ones that used to overflow a phone. Each test loads the
// page once and steps through the widths.

const PHONE_WIDTHS = [320, 360, 390, 639] as const;
const WIDE_WIDTHS = [640, 768, 1280] as const;
const HEIGHT = 800;
// A small phone: the page is taller than the screen even at 5 rows a page.
const SMALL_PHONE = { width: 320, height: 568 };

const TOTAL_EVENTS = 140;
// Every stub row shows it, and no other list on the page does.
const STUB_IP = "203.0.113.10";
const LONG_PHRASE = "Changed the organization's AI agent limit";
const LONG_NAME = "Alexandria Konstantinopoulou-Whitfield";
const LONG_BADGE = "via API Key - production-deployment-runner-west-coast-2";
// A user without a name is shown by email, which has nowhere to break.
const LONG_EMAIL = "averyveryverylongemailaddress.name@subdomain.example.com";

const bottom = (b: Box): number => b.y + b.height;
const right = (b: Box): number => b.x + b.width;

function stubEvent(id: number): Record<string, unknown> {
  const base = {
    id: `stub-${id}`,
    resourceUser: null,
    version: null,
    // Seconds apart, so every page is one "Today" group.
    createdAt: new Date(Date.now() - id * 1000).toISOString(),
    metadata: { ip: STUB_IP, country: "DK" },
  };
  if (id % 3 === 1) {
    return {
      ...base,
      action: "mcp_policy.updated",
      resourceType: "mcp_policy",
      resourceId: null,
      resourceName: null,
      diff: [{ kind: "E", path: ["maxScope"], lhs: null, rhs: "mcp:read" }],
      actor: {
        id: "stub-a",
        name: LONG_NAME,
        email: "a@example.com",
        role: "owner",
      },
      credential: {
        authMethod: "api-key",
        apiKeyName: LONG_BADGE.slice("via API Key - ".length),
      },
    };
  }
  return {
    ...base,
    action: "workflow.updated",
    resourceType: "workflow",
    resourceId: `wf-${id}`,
    resourceName: "Relayer balance less than 1 ETH",
    diff: [{ kind: "E", path: ["contentHash"], lhs: "a", rhs: "b" }],
    actor: { id: "stub-b", name: null, email: LONG_EMAIL, role: "admin" },
    credential: { authMethod: "session", apiKeyName: null },
  };
}

async function stubFeed(page: Page): Promise<void> {
  await page.route("**/api/security/audit*", async (route: Route) => {
    const url = new URL(route.request().url());
    const pageSize = Number(url.searchParams.get("limit") ?? 5);
    const totalPages = Math.ceil(TOTAL_EVENTS / pageSize);
    const current = Math.min(
      Number(url.searchParams.get("page") ?? 1),
      totalPages
    );
    const first = (current - 1) * pageSize + 1;
    const items = Array.from({ length: pageSize }, (_, i) =>
      stubEvent(first + i)
    );
    await route.fulfill({
      json: {
        items,
        meta: { total: TOTAL_EVENTS, page: current, pageSize, totalPages },
        _links: {},
      },
    });
  });
}

async function openActivity(
  page: Page,
  size: { width: number; height: number },
  query = ""
): Promise<void> {
  await dismissPhoneOverlays(page);
  await stubFeed(page);
  await page.setViewportSize(size);
  await page.goto(`/activity${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(`${TOTAL_EVENTS} events`)).toBeVisible({
    timeout: 30_000,
  });
}

// Resizing re-renders the nav beside the page, so each width's checks retry
// until the layout has settled.
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

function toolbar(page: Page): {
  search: Locator;
  filter: Locator;
  pageSize: Locator;
} {
  return {
    search: page.getByPlaceholder("Search name, email, workflow, IP..."),
    filter: page.getByRole("button", { name: "Filter", exact: true }),
    // The org switcher in the header is a combobox too.
    pageSize: page.getByRole("combobox").filter({ hasText: "/ page" }),
  };
}

// The first row the stub serves: long name, long badge and long action.
function longRow(page: Page): {
  row: Locator;
  name: Locator;
  badge: Locator;
  phrase: Locator;
} {
  const row = page.getByRole("listitem").filter({ hasText: LONG_PHRASE });
  return {
    row: row.first(),
    name: row.first().getByText(LONG_NAME, { exact: true }),
    badge: row.first().getByText(LONG_BADGE, { exact: true }),
    phrase: row.first().getByText(LONG_PHRASE, { exact: true }),
  };
}

function pager(page: Page): {
  nav: Locator;
  label: Locator;
  button: (name: string) => Locator;
} {
  const nav = page.getByRole("navigation", { name: "Pagination" });
  return {
    nav,
    // The phone-only "Page X of Y", announced when it changes.
    label: nav.locator("[aria-live]"),
    button: (name) => nav.getByRole("button", { name, exact: true }),
  };
}

async function hasSidewaysScroll(page: Page): Promise<boolean> {
  return await page.evaluate(() =>
    [...document.querySelectorAll("li, nav, main, body")].some(
      (element) => element.scrollWidth > element.clientWidth + 1
    )
  );
}

test.describe("Activity page on phones", () => {
  test("lays out the toolbar, rows and pager for a phone", async ({ page }) => {
    await openActivity(page, { width: PHONE_WIDTHS[0], height: HEIGHT });
    const { search, filter, pageSize } = toolbar(page);
    const { row, name, badge, phrase } = longRow(page);
    const { nav, label, button } = pager(page);

    for (const width of PHONE_WIDTHS) {
      await atWidth(page, width, async () => {
        expect(await hasSidewaysScroll(page), "nothing scrolls sideways").toBe(
          false
        );

        // Search has a row of its own; Filter and the page size share the next.
        const [searchBox, filterBox, sizeBox] = await Promise.all([
          box(search),
          box(filter),
          box(pageSize),
        ]);
        expect(filterBox.y).toBeGreaterThanOrEqual(bottom(searchBox));
        expect(overlaps(filterBox, sizeBox)).toBe(false);
        expect(Math.abs(filterBox.y - sizeBox.y)).toBeLessThanOrEqual(1);
        expect(sizeBox.height).toBe(filterBox.height);

        // The action has a line of its own under the name, and a long badge
        // stays inside its row.
        const [nameBox, phraseBox, badgeBox, rowBox] = await Promise.all([
          box(name),
          box(phrase),
          box(badge),
          box(row),
        ]);
        expect(phraseBox.y).toBeGreaterThanOrEqual(bottom(nameBox) - 1);
        expect(right(badgeBox)).toBeLessThanOrEqual(right(rowBox));

        // The long email is shown whole, wrapped rather than cut off: its line
        // (the identity block around the inline name) does not overflow.
        const email = page.getByText(LONG_EMAIL, { exact: true }).first();
        expect(await textFits(email.locator("xpath=../.."))).toBe(true);
        expect(right(await box(email))).toBeLessThanOrEqual(right(rowBox));

        // The pager offers first/last and says where you are; no numbers.
        await expect(label).toHaveText("Page 1 of 28");
        await expect(button("Last page")).toBeVisible();
        await expect(button("2")).toBeHidden();
        expect(right(await box(nav))).toBeLessThanOrEqual(width);
      });
    }
  });

  test("scrolls the whole page and keeps the pager in reach", async ({
    page,
  }) => {
    // Pages through the feed several times; give a loaded runner room.
    test.slow();
    await openActivity(page, SMALL_PHONE, "?size=25");
    const title = page.getByRole("heading", { name: "Organization activity" });
    const heading = page.getByText("Today", { exact: true });
    const { nav, label, button } = pager(page);
    // The app header's bottom edge, where the date headings stick: the fixed
    // bar that holds the user menu.
    const header = page
      .getByTestId("header-right")
      .locator(
        "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' fixed ')][1]"
      );
    const headerBottom = bottom(await box(header));

    await test.step("a page change from the top does not scroll", async () => {
      await button("Next page").click();
      await expect(label).toHaveText("Page 2 of 6");
      await expect(title).toBeInViewport();
      await button("Previous page").click();
      await expect(label).toHaveText("Page 1 of 6");
    });

    await test.step("the page scrolls, not just the list", async () => {
      await page.mouse.move(160, 400);
      await page.mouse.wheel(0, 1200);
      await expect(title).not.toBeInViewport();
      // The date heading sticks under the header and the pager to the bottom.
      await expect(async () => {
        expect(Math.abs((await box(heading)).y - headerBottom)).toBeLessThan(2);
        expect(bottom(await box(nav))).toBeGreaterThan(SMALL_PHONE.height - 40);
      }).toPass();
    });

    await test.step("a focused row stays clear of the stuck bars", async () => {
      // The pager's bar: its top border is where rows disappear under it.
      const bar = nav.locator("xpath=../..");
      // The nth row that opens something, by its button.
      const rowButton = (n: number): Locator =>
        page
          .getByRole("listitem")
          .filter({ hasText: STUB_IP })
          .filter({ has: page.getByRole("button") })
          .nth(n)
          .getByRole("button")
          .first();
      // Scroll the page so `row`'s top sits `at` px down the screen.
      const scrollRowTo = async (row: Locator, at: number): Promise<void> => {
        await row.evaluate((element, top) => {
          let scroller = element.parentElement;
          while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
            scroller = scroller.parentElement;
          }
          scroller?.scrollBy(0, element.getBoundingClientRect().top - top);
        }, at);
      };

      // Tabbing down onto a row that is mostly under the pager brings it out.
      const barTop = (await box(bar)).y;
      await scrollRowTo(rowButton(4), barTop - 20);
      await rowButton(3).focus();
      await page.keyboard.press("Tab");
      await expect(rowButton(4)).toBeFocused();
      expect(bottom(await box(rowButton(4)))).toBeLessThanOrEqual(
        (await box(bar)).y + 1
      );

      // Tabbing up onto a row that is mostly under the heading brings it out.
      const headingBottom = bottom(await box(heading));
      const above = rowButton(2);
      await scrollRowTo(above, headingBottom - (await box(above)).height + 20);
      await rowButton(3).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(above).toBeFocused();
      expect((await box(above)).y).toBeGreaterThanOrEqual(
        bottom(await box(heading)) - 1
      );
    });

    await test.step("a page change goes back to the top of the list", async () => {
      await button("Next page").click();
      await expect(label).toHaveText("Page 2 of 6");
      // The first row sits right under the stuck heading, not further down.
      const firstRow = page
        .getByRole("listitem")
        .filter({ hasText: STUB_IP })
        .first();
      await expect(async () => {
        const rowTop = (await box(firstRow)).y;
        expect(rowTop).toBeGreaterThan(headerBottom);
        expect(rowTop).toBeLessThan(headerBottom + 80);
      }).toPass();
    });

    await test.step("first and last jump to the ends, keeping focus", async () => {
      await button("Last page").click();
      await expect(label).toHaveText("Page 6 of 6");
      await expect(button("Next page")).toBeDisabled();
      await expect(button("Last page")).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(button("Last page")).toBeFocused();
      await button("First page").click();
      await expect(label).toHaveText("Page 1 of 6");
      await expect(button("First page")).toBeFocused();
    });
  });

  test("keeps the desktop layout from 640px up", async ({ page }) => {
    await openActivity(page, { width: WIDE_WIDTHS[0], height: HEIGHT });
    const { search, pageSize } = toolbar(page);
    const { name, phrase } = longRow(page);
    const { label, button } = pager(page);

    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, async () => {
        expect(await hasSidewaysScroll(page), "nothing scrolls sideways").toBe(
          false
        );

        // The page size stays beside the search box, however the open
        // sidebar wraps Filter (it can at 768px, as before).
        const [searchBox, sizeBox] = await Promise.all([
          box(search),
          box(pageSize),
        ]);
        expect(sizeBox.x).toBeGreaterThan(right(searchBox));
        expect(sizeBox.y).toBeLessThan(bottom(searchBox));

        // The action sits on the name's line.
        const [nameBox, phraseBox] = await Promise.all([
          box(name),
          box(phrase),
        ]);
        expect(phraseBox.y).toBeLessThan(bottom(nameBox));

        await expect(button("2")).toBeVisible();
        await expect(label).toBeHidden();
        await expect(button("Last page")).toBeHidden();
        // Previous is spent on page 1, and keeps focus (aria-disabled).
        await expect(button("Previous page")).toHaveAttribute(
          "aria-disabled",
          "true"
        );
      });
    }

    await test.step("Next is spent on the last page and keeps focus", async () => {
      await button("28").click();
      await expect(button("28")).toHaveAttribute("aria-current", "page");
      await button("Previous page").click();
      await expect(button("27")).toHaveAttribute("aria-current", "page");
      await button("Next page").focus();
      await page.keyboard.press("Enter");
      await expect(button("28")).toHaveAttribute("aria-current", "page");
      await expect(button("Next page")).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(button("Next page")).toBeFocused();
    });
  });
});
