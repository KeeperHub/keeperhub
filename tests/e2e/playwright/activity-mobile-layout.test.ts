import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { type Box, box, dismissPhoneOverlays } from "./utils/layout";

// The activity feed's layout on phones, and that nothing about it changes from
// 640px up. The feed is served from a stub so every width sees the same rows,
// including the long ones that used to overflow a phone. Each test loads the
// page once and steps through the widths.

const PHONE_WIDTHS = [320, 360, 390, 639] as const;
const WIDE_WIDTHS = [640, 768, 1280] as const;
const HEIGHT = 800;

const TOTAL_EVENTS = 140;
const LONG_PHRASE = "Changed the organization's AI agent limit";
const LONG_NAME = "Alexandria Konstantinopoulou-Whitfield";
const LONG_BADGE = "via API Key - production-deployment-runner-west-coast-2";
// A user without a name is shown by email, which has nowhere to break.
const LONG_EMAIL = "averyveryverylongemailaddress.name@subdomain.example.com";
const PAGE_LABEL_REGEX = /^Page \d+ of \d+$/;

const bottom = (b: Box): number => b.y + b.height;
const right = (b: Box): number => b.x + b.width;

function stubEvent(id: number): Record<string, unknown> {
  const base = {
    id: `stub-${id}`,
    resourceUser: null,
    version: null,
    createdAt: new Date(Date.now() - id * 3_600_000).toISOString(),
    metadata: { ip: "203.0.113.10", country: "DK" },
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

async function openActivity(page: Page, width: number): Promise<void> {
  await dismissPhoneOverlays(page);
  await stubFeed(page);
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(`${TOTAL_EVENTS} events`)).toBeVisible({
    timeout: 60_000,
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

async function hasSidewaysScroll(page: Page): Promise<boolean> {
  return await page.evaluate(() =>
    [...document.querySelectorAll("li, nav, main, body")].some(
      (element) => element.scrollWidth > element.clientWidth + 1
    )
  );
}

test.describe("Activity page on phones", () => {
  test("lays out the toolbar, rows and pager for a phone", async ({ page }) => {
    await openActivity(page, PHONE_WIDTHS[0]);
    const { search, filter, pageSize } = toolbar(page);
    const { row, name, badge, phrase } = longRow(page);
    const nav = page.getByRole("navigation", { name: "Pagination" });

    for (const width of PHONE_WIDTHS) {
      await atWidth(page, width, async () => {
        expect(await hasSidewaysScroll(page)).toBe(false);

        // Search has a row of its own; Filter and the page size share the next.
        const [searchBox, filterBox, sizeBox] = await Promise.all([
          box(search),
          box(filter),
          box(pageSize),
        ]);
        expect(filterBox.y).toBeGreaterThanOrEqual(bottom(searchBox));
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

        // The long email is shown whole, wrapped rather than cut off.
        const email = page.getByText(LONG_EMAIL, { exact: true }).first();
        expect(
          await email.evaluate((el) => el.scrollWidth <= el.clientWidth)
        ).toBe(true);

        // The pager offers first/last and says where you are; no numbers.
        await expect(nav.getByText(PAGE_LABEL_REGEX)).toBeVisible();
        await expect(
          nav.getByRole("button", { name: "Last page" })
        ).toBeVisible();
        await expect(
          nav.getByRole("button", { name: "2", exact: true })
        ).toBeHidden();
        expect(right(await box(nav))).toBeLessThanOrEqual(width);
      });
    }
  });

  test("scrolls the whole page and keeps the pager in reach", async ({
    page,
  }) => {
    await openActivity(page, 320);
    const nav = page.getByRole("navigation", { name: "Pagination" });
    const label = nav.getByText(PAGE_LABEL_REGEX);

    await test.step("the pager stays on screen while scrolling", async () => {
      await page.mouse.move(160, 400);
      await page.mouse.wheel(0, 600);
      await expect(async () => {
        expect(bottom(await box(nav))).toBeLessThanOrEqual(HEIGHT);
      }).toPass();
      await expect(page.getByText(LONG_PHRASE).nth(1)).toBeInViewport();
    });

    await test.step("a page change goes back to the top of the list", async () => {
      await nav.getByRole("button", { name: "Next page" }).click();
      await expect(label).toHaveText("Page 2 of 28");
      const first = page
        .getByRole("listitem")
        .filter({ hasText: LONG_PHRASE })
        .first();
      await expect(first).toBeInViewport();
    });

    await test.step("first and last jump to the ends", async () => {
      await nav.getByRole("button", { name: "Last page" }).click();
      await expect(label).toHaveText("Page 28 of 28");
      await expect(
        nav.getByRole("button", { name: "Next page" })
      ).toBeDisabled();
      await nav.getByRole("button", { name: "First page" }).click();
      await expect(label).toHaveText("Page 1 of 28");
    });
  });

  test("keeps the desktop layout from 640px up", async ({ page }) => {
    await openActivity(page, WIDE_WIDTHS[0]);
    const { search, pageSize } = toolbar(page);
    const { name, phrase } = longRow(page);
    const nav = page.getByRole("navigation", { name: "Pagination" });

    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, async () => {
        expect(await hasSidewaysScroll(page)).toBe(false);

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

        await expect(
          nav.getByRole("button", { name: "2", exact: true })
        ).toBeVisible();
        await expect(nav.getByText(PAGE_LABEL_REGEX)).toBeHidden();
        await expect(
          nav.getByRole("button", { name: "Last page" })
        ).toBeHidden();
      });
    }
  });
});
