import type { Locator, Page, Route } from "@playwright/test";
import type { ConnectionsResponse } from "@/components/settings/hub/hooks/use-mcp-connections";
import { SETTINGS_NAV } from "@/components/settings/hub/nav";
import { WALLET_EMAIL_DOMAIN } from "@/lib/auth/wallet-constants";
import { expect, test } from "./fixtures";
import {
  type Box,
  box,
  dismissPhoneOverlays,
  overlaps,
  textFits,
} from "./utils/layout";
import { openOrgSettings } from "./utils/settings";

const PHONE_WIDTHS = [320, 390];
const PHONE_HEIGHT = 844;
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };
// Tailwind's md: below it the rail gives way to the menu.
const MD = 768;
// The settings index: the menu on a phone, the first section beside the rail.
const MENU_PATH = "/settings";
const MENU_URL = /\/settings$/;
// Org-scoped sections, whose paths carry the organization. A link to one of
// these without it (/settings/users) reads the section as an org id. Taken
// from the nav itself, less segments an account-level section also uses
// (/settings/security is Account security), so a new section is covered too.
const ACCOUNT_SEGMENTS = new Set(
  SETTINGS_NAV.flatMap((group) => group.items)
    .filter((item) => item.scope === "user")
    .map((item) => item.segment)
);
const ORG_SEGMENTS = SETTINGS_NAV.flatMap((group) => group.items)
  .filter((item) => item.scope === "org" && !ACCOUNT_SEGMENTS.has(item.segment))
  .map((item) => item.segment);
const ORG_PATH_WITHOUT_ORG = new RegExp(
  `^/settings/(${ORG_SEGMENTS.join("|")})$`
);
const ACCOUNT_URL = /\/settings\/account$/;
// An org-scoped section carries the organization in its path.
const USERS_URL = /\/settings\/[^/]+\/users$/;
// The widest the side gutters get around a section on a phone or tablet.
const MAX_GUTTER = 24;
// In a stacked row the name keeps most of the line; the action cell only
// takes what its buttons need.
const MIN_HEADING_SHARE = 0.5;
// From this width "Members" and its 176px search fit on one line.
const SHARED_HEADER_FROM = 390;
// A card title's line box (text-sm): taller means it wrapped.
const ONE_LINE = 24;
// A section's code is compiled on first visit in development.
const FIRST_VISIT = { timeout: 20_000 };
// A wallet member's address and sign-in, the longest name a settings row
// carries. Accounts made before sign-up gave wallets a generated handle carry
// the address as their name too.
const WALLET_ADDRESS = `0x${"0".repeat(32)}deadbeef`;
const WALLET_EMAIL = `${WALLET_ADDRESS}@${WALLET_EMAIL_DOMAIN}`;
// How the agents table shows it: the short checksummed address, which keeps
// the tail that tells wallet members apart.
const WALLET_SHORT = "0x0000...Beef";
// An email long enough to be cut short in every layout but the widest.
const LONG_EMAIL =
  "a.rather.long.mailbox.name.for.layout@subdomain.example.com";
const DAY = 86_400_000;
// Days count up with no cap, so an old session reads "1,234 days ago".
const OLD = 1234 * DAY;
const AGENT_CLIENT =
  "A client name long enough to need the whole row and then some";
// What the row shows of the client id.
const AGENT_ID = "a1b2c3d4";
const OLD_AGENT_ID = "f6e5d4c3";
// Where the agents table is at nearly its narrowest: a phone on its side,
// with no rail, and an 11-inch tablet upright beside the rail.
const NARROW_TABLES = [640, 834];
// A small laptop beside the rail, where the table once pushed Revoke out.
const SMALL_LAPTOP = 1024;
// A long client name gets a line of its own rather than sharing one with its
// badge, which left it a letter or two in the narrowest columns.
const MIN_NAME = 100;
// The agents list, served as is so every width sees the same rows: someone
// with a session under a long client name and a long-standing one, a wallet
// member with none, and someone with a long email and none.
const AGENTS = {
  canManage: true,
  maxScope: null,
  users: [
    {
      userId: "agents-owner",
      userName: "Agents Owner",
      userEmail: "agents-owner@example.com",
      role: "owner",
      maxScope: null,
      canEdit: true,
      sessions: [
        {
          id: "agents-session",
          clientId: `${AGENT_ID}e5f6`,
          clientName: AGENT_CLIENT,
          userId: "agents-owner",
          userName: "Agents Owner",
          userEmail: "agents-owner@example.com",
          scope: "mcp:read",
          connectedAt: new Date(Date.now() - DAY).toISOString(),
          expiresAt: new Date(Date.now() + DAY).toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        {
          id: "agents-old-session",
          clientId: `${OLD_AGENT_ID}b2a1`,
          clientName: "Old client",
          userId: "agents-owner",
          userName: "Agents Owner",
          userEmail: "agents-owner@example.com",
          scope: "mcp:read",
          connectedAt: new Date(Date.now() - OLD).toISOString(),
          expiresAt: new Date(Date.now() + DAY).toISOString(),
          lastUsedAt: new Date(Date.now() - OLD).toISOString(),
          revokedAt: null,
        },
      ],
    },
    {
      userId: "agents-wallet",
      userName: WALLET_ADDRESS,
      userEmail: WALLET_EMAIL,
      role: "member",
      maxScope: null,
      canEdit: true,
      sessions: [],
    },
    {
      userId: "agents-long-email",
      userName: "",
      userEmail: LONG_EMAIL,
      role: "member",
      maxScope: null,
      canEdit: true,
      sessions: [],
    },
  ],
} satisfies ConnectionsResponse;

// These tests are about the settings layout, not what sits over it.
test.beforeEach(async ({ page }) => {
  await dismissPhoneOverlays(page);
});

async function contentFitsWidth(page: Page, width: number): Promise<void> {
  const main = page.getByTestId("settings-shell").locator("main");
  await expect
    .poll(() =>
      main.evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
    .toBe(true);
  // The first card spans the screen less its gutters: the rail used to take
  // 200px of it, leaving a column a word or two wide.
  // A section can be swapped for its loaded form right after it shows, so the
  // measurement is retried until it lands on one that stays.
  const card = main.locator("section").first();
  let measured: Box | null = null;
  await expect
    .poll(async () => {
      measured = await card.boundingBox();
      return measured;
    }, FIRST_VISIT)
    .not.toBeNull();
  const { x, width: cardWidth } = measured ?? (await box(card));
  expect(x).toBeLessThanOrEqual(MAX_GUTTER);
  expect(Math.abs(x - (width - x - cardWidth))).toBeLessThanOrEqual(1);
}

// The first card header's title and search field, once the field is there.
async function headerParts(page: Page): Promise<{ title: Box; search: Box }> {
  const header = page.locator("main section header").first();
  const search = header.locator("input");
  await expect(search).toBeVisible(FIRST_VISIT);
  return { title: await box(header.locator("h2")), search: await box(search) };
}

function centreY(target: Box): number {
  return target.y + target.height / 2;
}

// The members table's header row and its first member, once the list has
// loaded (the skeleton rows before it have no email).
async function membersTable(
  page: Page
): Promise<{ head: Locator; row: Locator }> {
  const table = page.locator("main table").first();
  const row = table.locator("tbody tr").first();
  await expect(row).toContainText("@", FIRST_VISIT);
  return { head: table.locator("thead tr"), row };
}

test.describe("settings on a phone", () => {
  test("opens on the menu, and each section leads back to it", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    // Not /workflows: it goes on to the latest workflow by itself, which can
    // overtake the tap on Settings.
    await page.goto("/hub", { waitUntil: "domcontentloaded" });

    await test.step("the drawer's Settings opens the menu", async () => {
      // A tap before the page has hydrated opens nothing, so try again
      // until the drawer is there.
      const drawer = page.getByTestId("mobile-nav");
      await expect(async () => {
        // A tap on an open drawer's button would only close it again.
        if (!(await drawer.isVisible())) {
          await page.getByTestId("mobile-nav-trigger").click();
        }
        await expect(drawer).toBeVisible({ timeout: 2000 });
      }).toPass(FIRST_VISIT);
      await page.getByTestId("mobile-nav-settings").click();
      await expect(page).toHaveURL(MENU_URL, FIRST_VISIT);
    });

    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible(FIRST_VISIT);
    await expect(page.getByTestId("settings-rail")).toBeHidden();
    await expect(page.getByTestId("settings-back-to-menu")).toHaveCount(0);

    // Org-scoped links get their organization once it has loaded.
    const users = page.getByTestId("settings-menu-users");
    await expect(users).toHaveAttribute("href", USERS_URL, FIRST_VISIT);
    await users.click();
    await expect(page).toHaveURL(USERS_URL, FIRST_VISIT);

    const back = page.getByTestId("settings-back-to-menu");
    await expect(back).toBeVisible(FIRST_VISIT);
    await back.click();
    await expect(page).toHaveURL(MENU_URL, FIRST_VISIT);
    await expect(menu).toBeVisible();

    await test.step("from inside a section, the drawer's Settings too", async () => {
      await users.click();
      await expect(page).toHaveURL(USERS_URL, FIRST_VISIT);
      await page.getByTestId("mobile-nav-trigger").click();
      await page.getByTestId("mobile-nav-settings").click();
      await expect(page).toHaveURL(MENU_URL, FIRST_VISIT);
      await expect(menu).toBeVisible();
    });
  });

  test("the menu never links a section without its organization", async ({
    page,
  }) => {
    // An empty list would check nothing.
    expect(ORG_SEGMENTS).toContain("users");
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto(MENU_PATH, { waitUntil: "domcontentloaded" });
    const hrefs = (): Promise<string[]> =>
      page.$$eval('[data-testid="settings-menu"] a[href]', (links) =>
        links.map((link) => link.getAttribute("href") ?? "")
      );
    // Before the organization has loaded, and after.
    expect((await hrefs()).filter((h) => ORG_PATH_WITHOUT_ORG.test(h))).toEqual(
      []
    );
    await expect(page.getByTestId("settings-menu-users")).toHaveAttribute(
      "href",
      USERS_URL,
      FIRST_VISIT
    );
    expect((await hrefs()).filter((h) => ORG_PATH_WITHOUT_ORG.test(h))).toEqual(
      []
    );
  });

  test("the menu comes from the server, not only after the page loads", async ({
    page,
  }) => {
    // Shown below md by CSS, so a phone sees it from the first paint.
    const response = await page.request.get(MENU_PATH);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('data-testid="settings-menu"');
  });

  test("the menu's search leads to a single setting", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await page.goto(MENU_PATH, { waitUntil: "domcontentloaded" });

    // The field is in the server's HTML, so it can be typed into before the
    // page has hydrated, and that text never reaches the search. Type again
    // until the matches show.
    const search = page.getByTestId("settings-menu-search");
    const match = page.getByTestId("settings-menu-match-security");
    await expect(async () => {
      await search.fill("");
      await search.fill("password");
      await expect(match).toBeVisible({ timeout: 2000 });
    }).toPass(FIRST_VISIT);
    await expect(page.getByTestId("settings-menu-users")).toHaveCount(0);
  });

  for (const width of PHONE_WIDTHS) {
    test(`sections use the whole screen at ${width}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: PHONE_HEIGHT });

      await test.step("Profile", async () => {
        await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
        await contentFitsWidth(page, width);
      });
      await test.step("Account security", async () => {
        await page.goto("/settings/security", {
          waitUntil: "domcontentloaded",
        });
        await contentFitsWidth(page, width);
      });
      await test.step("Users", async () => {
        await openOrgSettings(page, "users");
        await contentFitsWidth(page, width);
      });
      await test.step("a card's search beside its title, or under it", async () => {
        // Members' title is short enough to share its line with the search
        // from 390; Connections' is not, so its search takes the next.
        if (width >= SHARED_HEADER_FROM) {
          await openOrgSettings(page, "users");
          // Measured once the header has settled: the card can still be
          // laying out when its search first shows.
          await expect
            .poll(async () => {
              const parts = await headerParts(page);
              return Math.abs(centreY(parts.title) - centreY(parts.search));
            }, FIRST_VISIT)
            .toBeLessThanOrEqual(2);
          const members = await headerParts(page);
          expect(members.search.x).toBeGreaterThan(
            members.title.x + members.title.width
          );
        }

        await openOrgSettings(page, "connections");
        const connections = await headerParts(page);
        expect(connections.search.y).toBeGreaterThanOrEqual(
          connections.title.y + connections.title.height
        );
        // Its own line, and the title is not squeezed onto two.
        expect(connections.title.height).toBeLessThanOrEqual(ONE_LINE);
      });
    });
  }
});

test.describe("tables in a narrow column", () => {
  for (const width of [390, TABLET.width]) {
    test(`stack their rows at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: TABLET.height });
      await openOrgSettings(page, "users");

      const { head, row } = await membersTable(page);
      await expect(head).toBeHidden();
      // What a column header said, the row now says itself.
      await expect(row.getByText("Joined")).toBeVisible();
      const heading = await box(row.locator("td").first());
      const whole = await box(row);
      expect(heading.width / whole.width).toBeGreaterThan(MIN_HEADING_SHARE);
    });
  }

  test("stay tables on a desktop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openOrgSettings(page, "users");

    const { head, row } = await membersTable(page);
    await expect(head).toBeVisible();
    await expect(row.getByText("Joined")).toBeHidden();
  });

  test("still read as rows and cells, each naming its column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    await openOrgSettings(page, "users");
    const { head, row } = await membersTable(page);
    await expect(head).toBeHidden();
    // A grid row drops its implicit table roles in some engines.
    await expect(row).toHaveAttribute("role", "row");
    // With the header row hidden, the cell says which column it is.
    await expect(row.getByRole("cell", { name: /^Role\b/ })).toHaveCount(1);

    await page.goto("/settings/security", { waitUntil: "domcontentloaded" });
    const session = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: /^Location\b/ }) })
      .first();
    await expect(session).toBeVisible(FIRST_VISIT);
    await expect(
      session.getByRole("cell", {
        name: /^Last active (just now|\d+[mhd] ago)$/,
      })
    ).toHaveCount(1);
  });
});

test.describe("settings on wider screens", () => {
  for (const size of [TABLET, DESKTOP]) {
    test(`keep the rail and go straight to a section at ${size.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      // The server's page for /settings fills the column for a wide window
      // while it waits to move on, rather than leaving it empty.
      const index = await page.request.get(MENU_PATH);
      expect(await index.text()).toContain(
        'data-testid="settings-index-loading"'
      );
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(ACCOUNT_URL, FIRST_VISIT);
      await expect(page.getByTestId("settings-rail")).toBeVisible();
      await expect(page.getByTestId("settings-back-to-menu")).toBeHidden();
      // The phone's menu has nothing to add beside the rail.
      await expect(page.getByTestId("settings-menu")).toHaveCount(0);
    });
  }

  test("the rail and the way back to the menu meet at md", async ({ page }) => {
    for (const width of [MD - 1, MD]) {
      await page.setViewportSize({ width, height: TABLET.height });
      await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
      const rail = page.getByTestId("settings-rail");
      const back = page.getByTestId("settings-back-to-menu");
      // Exactly one of them, so no width is left without either.
      await expect(width < MD ? back : rail).toBeVisible(FIRST_VISIT);
      await expect(width < MD ? rail : back).toBeHidden();
    }
  });

  test("a plan's two figures do not run into each other", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openOrgSettings(page, "plans");

    // Each figure's box stayed inside its half of the row while the number
    // itself spilled out of it into the other one, so the text is what is
    // measured, not just the boxes.
    const figures = page.locator(".khp-metric-value");
    await expect(figures.first()).toBeVisible(FIRST_VISIT);
    for (const figure of await figures.all()) {
      expect(await textFits(figure)).toBe(true);
    }
    let pairs = 0;
    for (const metricsBox of await page.locator(".khp-metrics-box").all()) {
      const pair = metricsBox.locator(".khp-metric-value");
      if ((await pair.count()) === 2) {
        expect(await overlaps(pair.nth(0), pair.nth(1))).toBe(false);
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
  test("the plan comparison scrolls in a narrow column, not on a desktop", async ({
    page,
  }) => {
    // A tablet beside the rail has a narrow settings column too.
    for (const [size, scrolls] of [
      [TABLET, true],
      [DESKTOP, false],
    ] as const) {
      await page.setViewportSize(size);
      await openOrgSettings(page, "plans");
      const wrap = page.locator(".khp-table-wrap");
      await expect(wrap).toBeVisible(FIRST_VISIT);
      const scrollable = await wrap.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      );
      const pinned = await page
        .locator(".khp-td--label")
        .first()
        .evaluate((cell) => getComputedStyle(cell).position);
      expect(scrollable).toBe(scrolls);
      expect(pinned).toBe(scrolls ? "sticky" : "static");
    }
  });
});

test.describe("the connected agents table", () => {
  test("cuts long names short rather than scrolling", async ({ page }) => {
    await page.route("**/api/mcp/connections", async (route: Route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: AGENTS });
    });

    // The table's layout follows its column's width (container queries), so
    // one visit, resized, covers every width.
    await page.setViewportSize({
      width: PHONE_WIDTHS[0],
      height: TABLET.height,
    });
    await openOrgSettings(page, "agents");
    const card = page.locator("main section").filter({
      has: page.getByRole("heading", { name: "Connected agents" }),
    });
    const table = card.locator("table");
    const rows = table.locator("tbody tr");
    const wallet = rows.filter({ hasText: WALLET_SHORT });
    const longEmail = rows.filter({ hasText: LONG_EMAIL });
    const session = rows.filter({ hasText: AGENT_ID });
    const oldSession = rows.filter({ hasText: OLD_AGENT_ID });
    await expect(wallet).toBeVisible(FIRST_VISIT);

    for (const width of [
      ...PHONE_WIDTHS,
      TABLET.width,
      ...NARROW_TABLES,
      SMALL_LAPTOP,
      DESKTOP.width,
    ]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: TABLET.height });
        await expect(session).toBeVisible();

        // The table stays inside its card: nothing to scroll sideways to.
        expect(
          await card
            .locator("[data-slot=table-container]")
            .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);

        // Text ends inside the card, and as a table inside its own column,
        // short of the cell beside it.
        const cardBox = await box(card);
        const asTable = await table.locator("thead tr").isVisible();
        const endsBy = async (row: Locator, column: number): Promise<number> =>
          asTable
            ? (await box(row.locator("td").nth(column))).x
            : cardBox.x + cardBox.width;
        const endsInside = async (
          text: Locator,
          row: Locator,
          column = 1
        ): Promise<void> => {
          const shown = await box(text);
          expect(shown.x + shown.width).toBeLessThanOrEqual(
            await endsBy(row, column)
          );
        };
        const fitsOrEllipsis = async (text: Locator): Promise<void> => {
          if (!(await textFits(text))) {
            expect(
              await text.evaluate(
                (element) => getComputedStyle(element).textOverflow
              )
            ).toBe("ellipsis");
          }
        };
        if (asTable) {
          expect(await textFits(table.locator("th").first())).toBe(true);
        }

        // A wallet member named by their address reads as the short address
        // on both lines, whole, with the full sign-in in its title.
        await expect(
          wallet.getByText(WALLET_SHORT, { exact: true })
        ).toHaveCount(2);
        const short = wallet.getByText(WALLET_SHORT, { exact: true }).last();
        expect(await textFits(short)).toBe(true);
        await endsInside(short, wallet);
        expect(await short.getAttribute("title")).toBe(WALLET_EMAIL);

        // A long email is what gives way, ending in an ellipsis, while what
        // is connected stays readable, under the address if need be.
        for (const address of await longEmail
          .getByText(LONG_EMAIL, { exact: true })
          .all()) {
          await endsInside(address, longEmail);
          await fitsOrEllipsis(address);
        }
        for (const person of [wallet, longEmail]) {
          const summary = person.getByText("· No agents connected");
          expect(await textFits(summary)).toBe(true);
          await endsInside(summary, person);
        }

        // A long client name keeps a readable width, and when it was
        // connected and the id that tells same-named sessions apart stay
        // whole, however long ago that was.
        const name = await box(session.getByText(AGENT_CLIENT));
        expect(name.width).toBeGreaterThan(MIN_NAME);
        for (const [row, id] of [
          [session, AGENT_ID],
          [oldSession, OLD_AGENT_ID],
        ] as const) {
          const connected = row.getByText(/^Connected /);
          expect(await textFits(connected)).toBe(true);
          await endsInside(connected, row);
          const shownId = row.getByText(id, { exact: true });
          expect(await textFits(shownId)).toBe(true);
          await endsInside(shownId, row);

          // When it was last used ends short of Revoke, cut short if it must
          // be with the whole of it in the title.
          const lastUsed = row.locator("td").nth(2).locator("[title]");
          await endsInside(lastUsed, row, 3);
          await fitsOrEllipsis(lastUsed);

          // Revoke stays in reach.
          const revoke = await box(row.getByRole("button", { name: "Revoke" }));
          expect(revoke.x + revoke.width).toBeLessThanOrEqual(
            cardBox.x + cardBox.width
          );
        }
      });
    }
  });
});
