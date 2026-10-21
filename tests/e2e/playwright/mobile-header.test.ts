import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  addTestOrganization,
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
  removeTestOrganization,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

const PHONE = { width: 390, height: 844 };
const PHONE_SIDEWAYS = { width: 844, height: 390 };
const DESKTOP = { width: 1280, height: 800 };
const EMPTY_REGEX = /^$/;
// "…0de3": the last 4 characters of the wallet address.
const TAIL_ADDRESS_REGEX = /^…\w{4}$/;
const FULL_ADDRESS_REGEX = /^0x\w{4}\.\.\.\w{4}$/;
const WALLET_NAME_REGEX = /^Wallet 0x\w{4}\.\.\.\w{4}$/;
const ANALYTICS_URL_REGEX = /\/analytics$/;
// The Save button's title, also while an autosave runs.
const SAVE_TITLE_REGEX = /^(Save workflow|Saving\.\.\.)$/;
// Portrait phone widths, narrowest to widest, plus the two the wallet's
// address switches at.
const PHONE_WIDTHS = [320, 360, 375, 390, 414, 420, 430];
// Phones turned sideways and tablets, where the org switcher shows its name.
const WIDE_WIDTHS = [640, 667, 740, 768, 820];
// Widths at which the workflow editor's header must fit: below 768px its
// buttons float in a bar at the bottom, from 768px they sit in the header.
const EDITOR_WIDTHS = [320, 375, 390, 640, 667, 740, 768, 820, 1023];
// Phones, upright and sideways, where the editor's buttons are in the bar.
// The phone bar has room for the Enable switch from 375px (xs).
const SWITCH_IN_BAR_FROM = 375;
const EDITOR_BAR_SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
  { width: 767, height: 800 },
];
// A wallet address for the editor test's stand-in wallet.
// Mostly zeros: a made-up address, which the contract scanner skips.
const STAND_IN_WALLET = `0x39c9${"0".repeat(32)}0de3`;
// The stand-in wallet of a second organization.
const SECOND_WALLET = `0x5a1b${"0".repeat(32)}beef`;
const STAND_IN_TAIL_REGEX = /0de3$/i;
const SECOND_TAIL_REGEX = /beef$/i;
// Long enough to need two lines in the 200px list.
const SECOND_ORG_NAME = "E2E Second Organization With A Long Name";
// The test user's seeded organization, as its switcher shows and names it.
const HOME_ORG = "E2E Test Organization";
const HOME_INITIALS = "ET";
const HOME_LABEL = "E2E Test Organization (ET), switch organization";
// The switcher's offer to open an org again, for whichever org it is.
const TRY_OPEN_REGEX = /^Try again: open /;

// The header keeps at least this much between its two sides when it fits.
const HEADER_SIDES_MIN_GAP = 8;

// Below 768px the app warns once that it is best on a larger screen, in a
// dialog over everything, and an announcement banner can sit above the
// header; these tests are about the header and what is under it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("keeperhub-mobile-warning-dismissed", "true");
      window.localStorage.setItem("kh-billing-announce-v1", "1");
    } catch {
      // A sandboxed frame has no storage, and no dialog either.
    }
  });
});

// The organizations switched to from now on, in order.
function trackOrgSwitches(page: Page): string[] {
  const switchedTo: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/organization/set-active")) {
      const body = request.postDataJSON() as { organizationId?: string };
      switchedTo.push(body?.organizationId ?? "");
    }
  });
  return switchedTo;
}

// Toasts about switching organization, or opening one when none is active
// (in progress, done or failed).
function switchToasts(page: Page): Locator {
  return page
    .locator("[data-sonner-toast]")
    .filter({ hasText: /switch|open/i });
}

// The org switcher renders once the session has loaded on the client, so
// the header's buttons respond to taps from then on.
async function waitForSignedInHeader(page: Page): Promise<void> {
  await expect(page.getByTestId("org-switcher")).toHaveAttribute(
    "data-state",
    "ready",
    { timeout: 15_000 }
  );
}

async function waitForSignedOutHeader(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible({
    timeout: 15_000,
  });
}

// The org's name, which the switcher renders whether or not it shows it.
async function orgName(page: Page): Promise<string> {
  return (
    (await page
      .getByTestId("org-switcher")
      .locator("[data-org-name]")
      .textContent()) ?? ""
  );
}

function switcherName(page: Page) {
  return page.getByTestId("org-switcher").locator("[data-org-name]");
}

function switcherInitials(page: Page) {
  return page.getByTestId("org-switcher").locator("[data-org-initials]");
}

// How far the header's left side reaches past the start of its right side
// (negative: they overlap), from what is actually drawn in each.
async function headerSidesGap(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const left = document.querySelector('[data-testid="header-left"]');
    const right = document.querySelector('[data-testid="header-right"]');
    if (!(left && right)) {
      throw new Error("header sides not found");
    }
    let leftEnd = 0;
    for (const element of left.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        leftEnd = Math.max(leftEnd, box.right);
      }
    }
    return right.getBoundingClientRect().left - leftEnd;
  });
}

// Whether the centre of an element is drawn on top, so a tap there reaches it.
async function isOnTop(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

// The header's first and last controls are wholly on screen.
async function expectHeaderEndsOnScreen(
  page: Page,
  width: number
): Promise<void> {
  await expect(
    page.getByTestId("user-menu"),
    `avatar on screen at ${width}px`
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("link", { name: "KeeperHub Logo" }).first(),
    `logo on screen at ${width}px`
  ).toBeInViewport({ ratio: 1 });
}

// The test user has no wallet (the e2e setup removes it): stand one in, for
// the address's forms and for a header as crowded as a real user's.
async function stubWallet(page: Page): Promise<void> {
  await page.route("**/api/user/wallet", async (route) => {
    await route.fulfill({
      json: { hasWallet: true, walletAddress: STAND_IN_WALLET },
    });
  });
}

// The wallet address as shown: the visible one of its forms, or "".
async function shownAddress(page: Page): Promise<string> {
  return await page.getByTestId("wallet-toolbar-address").evaluate((button) =>
    [...button.querySelectorAll<HTMLElement>("span.font-mono")]
      .filter((span) => span.offsetWidth > 0)
      .map((span) => span.textContent ?? "")
      .join("")
  );
}

// The gap between the header's two sides: 8px in the phone header (phones,
// and touch tablets below lg), none in the desktop one.
async function headerGap(page: Page): Promise<string> {
  return await page
    .getByTestId("header-left")
    .evaluate(
      (element) => getComputedStyle(element.parentElement ?? element).columnGap
    );
}

const PHONE_GAP = "8px";
const DESKTOP_GAP = "normal";

function avatarOrgItem(page: Page): Locator {
  return page.getByRole("menuitem", { name: HOME_ORG, exact: true });
}

// Opens the avatar menu (one of its items shows) and reports whether it has
// the organization item, then closes it.
async function avatarMenuHasOrg(page: Page): Promise<boolean> {
  await page.getByTestId("user-menu").click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  const has = (await avatarOrgItem(page).count()) > 0;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  return has;
}

// The header is fixed, so overflowing it never scrolls the page: it fits
// when both ends are on screen and its two sides do not overlap.
async function expectHeaderFits(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await expectHeaderEndsOnScreen(page, width);
  await expect
    .poll(() => headerSidesGap(page), {
      message: `header sides overlap at ${width}px`,
    })
    .toBeGreaterThanOrEqual(HEADER_SIDES_MIN_GAP);
}

// After a resize the toolbar's buttons animate their size (Run's label comes
// and goes with the width): wait for that to finish before measuring.
async function settleToolbar(page: Page): Promise<void> {
  await page.getByTestId("workflow-actions").evaluate(async (element) => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished)
    );
  });
}

// On a phone the editor's buttons float in a bar at the bottom: wholly on
// screen, every control inside it and clear of the next, Run last and
// tappable, the Enable switch beside it from 375px, and the canvas's zoom
// controls above the bar. The workflow has a selected step and a trigger
// that can be switched on and off.
async function expectEditorBar(page: Page, width: number): Promise<void> {
  const bar = page.getByTestId("workflow-actions");
  await settleToolbar(page);
  await expect(bar, `bar on screen at ${width}px`).toBeInViewport({
    ratio: 1,
  });
  const enableSwitch = bar.getByRole("switch");
  if (width < SWITCH_IN_BAR_FROM) {
    await expect(
      enableSwitch,
      `no room for the switch at ${width}px`
    ).toBeHidden();
  } else {
    await expect(enableSwitch, `switch in the bar at ${width}px`).toBeVisible();
    // A 44px tall tap area: 20px above and below its middle still reach it.
    const reached = await enableSwitch.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return [y - 20, y + 20].every((pointY) => {
        const hit = document.elementFromPoint(x, pointY);
        return hit !== null && element.contains(hit);
      });
    });
    expect(reached, `switch's tap area at ${width}px`).toBe(true);
  }
  await expect(async () => {
    const { barBox, controls } = await bar.evaluate((element) => {
      const edges = (box: DOMRect) => ({
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
      });
      return {
        barBox: edges(element.getBoundingClientRect()),
        controls: [...element.querySelectorAll("button")]
          .map((button) => ({
            ...edges(button.getBoundingClientRect()),
            text: button.textContent?.trim() ?? "",
          }))
          .filter((box) => box.width > 0),
      };
    });
    // Configuration, Delete, Save, Export, Visibility, Listing, the switch
    // (from 375px) and Run.
    expect(controls.length, `bar controls at ${width}px`).toBe(
      width < SWITCH_IN_BAR_FROM ? 7 : 8
    );
    for (const [index, box] of controls.entries()) {
      const where = `control ${index} at ${width}px`;
      expect(box.left, `${where} inside the bar`).toBeGreaterThanOrEqual(
        barBox.left
      );
      expect(box.right, where).toBeLessThanOrEqual(barBox.right);
      expect(box.top, where).toBeGreaterThanOrEqual(barBox.top);
      expect(box.bottom, where).toBeLessThanOrEqual(barBox.bottom);
      if (index > 0) {
        expect(box.left, `${where} clear of the one before`).toBeGreaterThan(
          controls[index - 1].right
        );
      }
    }
    expect(controls.at(-1)?.text, `Run last at ${width}px`).toBe("Run");
    // At the bar's end: as far from its right edge as Configuration is from
    // its left.
    expect(
      Math.round(barBox.right - (controls.at(-1)?.right ?? 0)),
      `Run at the bar's end at ${width}px`
    ).toBe(Math.round(controls[0].left - barBox.left));
  }).toPass();
  const run = bar.getByRole("button", { name: "Run", exact: true });
  await expect
    .poll(() => isOnTop(run), { message: `Run tappable at ${width}px` })
    .toBe(true);
  const controlsPanel = page.locator(".workflow-controls-panel");
  await expect(controlsPanel).toBeVisible();
  const panelBox = await controlsPanel.boundingBox();
  const barBox = await bar.boundingBox();
  expect(
    (panelBox?.y ?? 0) + (panelBox?.height ?? 0),
    `zoom controls above the bar at ${width}px`
  ).toBeLessThanOrEqual(barBox?.y ?? 0);
}

test.describe("Mobile header", () => {
  // Phones and tablets are touch screens. Playwright reports a mouse
  // otherwise, and a 768-1023px window differs by pointer.
  test.use({ hasTouch: true });

  test("a phone gets the nav in a drawer and the org initials", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);

    // No sidebar on a phone; the header's button opens the same items.
    await expect(page.getByTestId("navigation-sidebar")).toHaveCount(0);
    const trigger = page.getByTestId("mobile-nav-trigger");
    await expect(trigger).toBeVisible();
    // The logo's tap area is wider than its 18px mark.
    expect(
      (
        await page
          .getByRole("link", { name: "KeeperHub Logo" })
          .first()
          .boundingBox()
      )?.width ?? 0
    ).toBeGreaterThanOrEqual(26);

    // The org switcher shows the org's initials and opens the full list.
    const switcher = page.getByTestId("org-switcher");
    await expect(switcherInitials(page)).toBeVisible();
    await expect(switcherInitials(page)).toHaveText(HOME_INITIALS);
    await expect(switcherName(page)).toBeHidden();
    // Spoken as what it shows, so voice control finds it by the initials.
    await expect(switcher).toHaveAttribute("aria-label", HOME_LABEL);
    await switcher.click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    // The header has the switcher, so the avatar menu has no org item.
    expect(await avatarMenuHasOrg(page)).toBe(false);

    // A pick navigates and closes the drawer.
    await trigger.click();
    const drawer = page.getByTestId("mobile-nav");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("mobile-nav-hub")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await page.getByTestId("mobile-nav-analytics").click();
    await page.waitForURL(ANALYTICS_URL_REGEX);
    await expect(drawer).toHaveCount(0);
  });

  test("the header fits phones, phones turned sideways and tablets", async ({
    page,
  }) => {
    // With a wallet, as crowded as a real user's header.
    await stubWallet(page);
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await expect(page.getByTestId("wallet-toolbar-address")).toBeVisible();
    for (const width of [...PHONE_WIDTHS, ...WIDE_WIDTHS]) {
      await expectHeaderFits(page, width);
    }
  });

  test("the drawer scrolls on a phone turned sideways below the breakpoint", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    // Turned sideways there is room for the org switcher as on desktop.
    await expect(switcherName(page)).toBeVisible();
    await expect(switcherInitials(page)).toBeHidden();
    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav");
    // Wholly on screen once it has slid in.
    await expect(drawer).toBeInViewport({ ratio: 1 });
    // The last link starts below the fold and is reached by scrolling.
    const docs = drawer.getByRole("link", { name: "Documentation" });
    await expect(docs).not.toBeInViewport();
    const box = await drawer.boundingBox();
    if (!box) {
      throw new Error("drawer has no box");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1000);
    await expect(docs).toBeInViewport();
    // The close button stays in view after scrolling, a 44px target.
    const close = drawer.getByRole("button", { name: "Close" });
    await expect(close).toBeInViewport();
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
  });

  test("a wide phone turned sideways keeps the sidebar", async ({ page }) => {
    await page.setViewportSize(PHONE_SIDEWAYS);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await expect(page.getByTestId("navigation-sidebar")).toBeVisible();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
  });

  test("the nav button gives way to the sidebar at 768px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible();
    await expect(page.getByTestId("navigation-sidebar")).toHaveCount(0);
    await page.setViewportSize({ width: 768, height: 800 });
    await expect(page.getByTestId("navigation-sidebar")).toBeVisible();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
  });

  test("the switcher shows initials up to 639px and the name from 640px", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await page.setViewportSize({ width: 639, height: 800 });
    await expect(switcherInitials(page)).toBeVisible();
    await expect(switcherName(page)).toBeHidden();
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(switcherName(page)).toBeVisible();
    await expect(switcherInitials(page)).toBeHidden();
  });

  test("an open drawer closes when the screen widens past the breakpoint", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByTestId("mobile-nav")).toBeVisible();
    await page.setViewportSize(PHONE_SIDEWAYS);
    await expect(page.getByTestId("mobile-nav")).toHaveCount(0);
    await expect(page.getByTestId("navigation-sidebar")).toBeVisible();
  });

  test("the editor's header fits every width; on phones its buttons float at the bottom", async ({
    page,
  }) => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `mobile-header-editor-${Date.now()}`,
    });
    try {
      await stubWallet(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForCanvas(page);
      await waitForSignedInHeader(page);
      // On desktop the workflow's name sits 16px after the switcher (the
      // header's 8px gap and its own 8px margin).
      const switcherBox = await page.getByTestId("org-switcher").boundingBox();
      const nameBox = await page
        .getByTestId("header-left")
        .getByText(workflow.name)
        .boundingBox();
      expect(
        Math.round(
          (nameBox?.x ?? 0) -
            ((switcherBox?.x ?? 0) + (switcherBox?.width ?? 0))
        )
      ).toBe(16);
      // A selected step adds Delete: the most crowded case.
      await page.locator(".react-flow__node-trigger").first().click();
      await expect(page.getByTitle("Delete", { exact: true })).toHaveCount(1);
      await expect(page.getByTestId("wallet-toolbar-address")).toContainText(
        "0x"
      );
      for (const width of EDITOR_WIDTHS) {
        await expectHeaderFits(page, width);
      }
      // From 768px the buttons sit in the header's one row, on the avatar's
      // line; the switcher gives way to them, never under its 76px floor,
      // and the wallet is never squeezed. With a selection the Enable switch
      // is there from 840px only.
      const walletWidths: number[] = [];
      for (const { width, switchShown } of [
        // Beside a selection's Delete the narrow tablet header has no room.
        { width: 768, switchShown: false },
        { width: 1023, switchShown: true },
      ]) {
        await page.setViewportSize({ width, height: 800 });
        await settleToolbar(page);
        const middle = async (locator: Locator): Promise<number> => {
          const box = await locator.boundingBox();
          return Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);
        };
        const avatarMiddle = await middle(page.getByTestId("user-menu"));
        const enableSwitch = page
          .getByTestId("workflow-actions")
          .getByRole("switch");
        if (switchShown) {
          await expect(enableSwitch).toBeVisible();
          expect(await middle(enableSwitch)).toBe(avatarMiddle);
        } else {
          await expect(enableSwitch).toBeHidden();
        }
        for (const control of [
          page.getByTitle("Configuration", { exact: true }),
          page.getByTitle("Delete", { exact: true }),
          page.getByTitle(SAVE_TITLE_REGEX),
          page.getByTitle("Export workflow as JSON"),
          page.getByRole("button", { name: "Run", exact: true }),
        ]) {
          expect(
            await middle(control),
            `${await control.getAttribute("title")} on the avatar's line at ${width}px`
          ).toBe(avatarMiddle);
        }
        await expect(
          page.getByTestId("org-switcher").locator("xpath=.."),
          `switcher floor at ${width}px`
        ).toHaveCSS("min-width", "76px");
        await expect
          .poll(
            async () =>
              (await page.getByTestId("org-switcher").boundingBox())?.width ??
              0,
            { message: `switcher width at ${width}px` }
          )
          .toBeGreaterThanOrEqual(75.5);
        walletWidths.push(
          (await page.getByTestId("wallet-toolbar-address").boundingBox())
            ?.width ?? 0
        );
      }
      expect(walletWidths[0], "the wallet keeps its size at 768px").toBe(
        walletWidths[1]
      );
      // A toast (say, the paid-features notice on opening a workflow) sits
      // over the bar until it times out, and a pointer resting on it holds
      // it: move the pointer away and let it go.
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
        timeout: 15_000,
      });
      for (const size of EDITOR_BAR_SIZES) {
        await page.setViewportSize(size);
        await expectEditorBar(page, size.width);
      }
      // Where the toolbar has no room for the switch, the Configuration sheet
      // has it, with a step selected or not; where the toolbar has it, the
      // sheet does not.
      const sheetSwitch = page.getByRole("switch", {
        name: "Workflow enabled",
      });
      const expectSheetSwitch = async (
        size: { width: number; height: number },
        shown: boolean
      ): Promise<void> => {
        await page.setViewportSize(size);
        await page.getByTitle("Configuration", { exact: true }).click();
        // A drawer on phones, a centred panel from md (which has no dialog
        // role): found by its Close button either way.
        const closeSheet = page
          .getByRole("button", { name: "Close", exact: true })
          .filter({ visible: true });
        await expect(closeSheet).toHaveCount(1);
        if (shown) {
          await expect(
            sheetSwitch,
            `sheet switch at ${size.width}px`
          ).toBeVisible();
        } else {
          await expect(
            sheetSwitch,
            `no sheet switch at ${size.width}px`
          ).toBeHidden();
        }
        await closeSheet.click();
        await expect(closeSheet).toHaveCount(0);
      };
      await expectSheetSwitch({ width: 320, height: 568 }, true);
      await expectSheetSwitch({ width: 800, height: 800 }, true);
      await expectSheetSwitch({ width: 1000, height: 800 }, false);
      await page.setViewportSize({ width: 320, height: 568 });
      await page
        .locator(".react-flow__pane")
        .click({ position: { x: 8, y: 120 } });
      await expect(page.getByTitle("Delete", { exact: true })).toHaveCount(0);
      await expectSheetSwitch({ width: 320, height: 568 }, true);
      await expectSheetSwitch({ width: 390, height: 844 }, false);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("on a phone the AI prompt sits above the editor's buttons", async ({
    page,
  }) => {
    test.skip(
      process.env.NEXT_PUBLIC_AI_PROMPT_ENABLED !== "true",
      "the AI prompt is off in this build"
    );
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `mobile-header-prompt-${Date.now()}`,
    });
    try {
      await stubWallet(page);
      await page.setViewportSize(PHONE);
      await page.goto(`/workflows/${workflow.id}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForCanvas(page);
      await waitForSignedInHeader(page);
      await settleToolbar(page);
      const prompt = page.getByRole("form", {
        name: "KeeperHub workflow prompt",
      });
      await expect(prompt).toBeInViewport({ ratio: 1 });
      const promptBox = await prompt.boundingBox();
      const barBox = await page.getByTestId("workflow-actions").boundingBox();
      const controlsBox = await page
        .locator(".workflow-controls-panel")
        .boundingBox();
      expect(
        (promptBox?.y ?? 0) + (promptBox?.height ?? 0),
        "prompt above the bar"
      ).toBeLessThanOrEqual(barBox?.y ?? 0);
      expect(
        (promptBox?.x ?? 0) + (promptBox?.width ?? 0),
        "prompt clear of the zoom controls"
      ).toBeLessThanOrEqual(controlsBox?.x ?? 0);
      await expect
        .poll(() => isOnTop(prompt), { message: "prompt tappable" })
        .toBe(true);
    } finally {
      await deleteTestWorkflow(workflow.id);
    }
  });

  test("below 375px the org switcher is in the drawer, not the header", async ({
    page,
  }) => {
    await stubWallet(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    const header = page.getByTestId("org-switcher");
    const trigger = page.getByTestId("mobile-nav-trigger");
    const drawer = page.getByTestId("mobile-nav");
    const inMenu = page.getByTestId("mobile-nav-org-switcher");
    await expect(header).toBeHidden();
    await trigger.click();
    // In the drawer it has the room for the name, and is a 44px target.
    await expect(inMenu.locator("[data-org-name]")).toBeVisible();
    await expect(inMenu.locator("[data-org-name]")).toHaveText(HOME_ORG);
    expect((await inMenu.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    // Escape closes its list, not the drawer (whose button says at once).
    await inMenu.click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Its 44px rows are as tall as the drawer's own (measured once the list
    // has finished opening).
    await inMenu.click();
    const current = page.getByRole("option").filter({ hasText: HOME_ORG });
    await expect
      .poll(async () => (await current.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    // Picking the organization already in use only closes the drawer, with
    // focus back on its button: there is nothing to switch or announce.
    await current.click();
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // Named, so a stray toast says which it was.
    expect(await switchToasts(page).allTextContents()).toEqual([]);
    await expect(page.getByTestId("wallet-toolbar-address")).toBeVisible();
    // Either side of 375px, exactly one of the two is there.
    for (const [width, inHeader] of [
      [374, false],
      [375, true],
    ] as const) {
      await page.setViewportSize({ width, height: 667 });
      await trigger.click();
      await expect(drawer).toBeVisible();
      if (inHeader) {
        await expect(header, `header at ${width}px`).toBeVisible();
        await expect(inMenu, `drawer at ${width}px`).toBeHidden();
      } else {
        await expect(header, `header at ${width}px`).toBeHidden();
        await expect(inMenu, `drawer at ${width}px`).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    }
  });

  test("the wallet address shortens with the width; copy and settings stay", async ({
    page,
  }) => {
    await stubWallet(page);
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await expect(page.getByTestId("wallet-toolbar-address")).toBeVisible();
    for (const [width, form] of [
      [374, EMPTY_REGEX],
      [375, TAIL_ADDRESS_REGEX],
      [419, TAIL_ADDRESS_REGEX],
      [420, FULL_ADDRESS_REGEX],
      [1280, FULL_ADDRESS_REGEX],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() => shownAddress(page), { message: `address at ${width}px` })
        .toMatch(form);
      // Spoken the same whatever is shown.
      await expect(
        page.getByTestId("wallet-toolbar-address")
      ).toHaveAccessibleName(WALLET_NAME_REGEX);
      await expect(page.getByTestId("wallet-toolbar-copy")).toBeVisible();
      await expect(page.getByTestId("wallet-toolbar-settings")).toBeVisible();
      if (form === TAIL_ADDRESS_REGEX) {
        // "…" could break the line before the 4 characters.
        await expect(
          page
            .getByTestId("wallet-toolbar-address")
            .locator("span.font-mono")
            .filter({ hasText: "…" })
        ).toHaveCSS("white-space", "nowrap");
      }
    }
    // The last 4 are the same as the end of the full form.
    await page.setViewportSize({ width: 420, height: 800 });
    const full = await shownAddress(page);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(() => shownAddress(page)).toBe(`…${full.slice(-4)}`);
  });

  test("the switcher swaps its name for initials under about 114px", async ({
    page,
  }) => {
    // Below lg, where the header switcher gives way to a crowded header.
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    const switcher = page.getByTestId("org-switcher");
    // Squeezed as a crowded header would, either side of the switch point.
    // Re-applied on each try: a re-render into the loading state replaces
    // the button and drops the inline width.
    const expectAtWidth = async (
      width: number,
      shown: Locator,
      hidden: Locator
    ): Promise<void> => {
      const measure = async (): Promise<number> =>
        await switcher.evaluate((element) =>
          Math.round(element.getBoundingClientRect().width)
        );
      await expect(async () => {
        await switcher.evaluate((element, px) => {
          element.style.width = `${px}px`;
          element.style.minWidth = "0";
        }, width);
        expect(await measure(), `switcher width at ${width}px`).toBe(width);
        await expect(shown).toBeVisible({ timeout: 1000 });
        await expect(hidden).toBeHidden({ timeout: 1000 });
        // Still at that width: a re-render in between would have reset it.
        expect(await measure(), `switcher width at ${width}px`).toBe(width);
      }).toPass({ timeout: 10_000 });
    };
    await expectAtWidth(110, switcherInitials(page), switcherName(page));
    await expectAtWidth(118, switcherName(page), switcherInitials(page));
  });

  test("a touch tablet has the switcher in the header up to 1023px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "a touch screen"
    ).toBe(true);
    const switcher = page.getByTestId("org-switcher");
    await expect(switcher).toBeVisible();
    expect(await headerGap(page)).toBe(PHONE_GAP);
    await expect(switcher).toHaveAttribute("aria-label", HOME_LABEL);
    // The avatar menu's organization item is for a mouse window only.
    expect(await avatarMenuHasOrg(page)).toBe(false);
    // Picking the organization already in use only closes the list: in the
    // workflow editor, switching to it again would clear the canvas.
    await switcher.click();
    await page.getByRole("option").filter({ hasText: HOME_ORG }).click();
    await expect(page.getByRole("option")).toHaveCount(0);
    // Named, so a stray toast says which it was.
    expect(await switchToasts(page).allTextContents()).toEqual([]);
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect(switcher).toHaveAttribute("aria-label", HOME_LABEL);
    // From lg the desktop header: the plain label, no gap.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(switcher).toHaveAttribute("aria-label", "Switch organization");
    expect(await headerGap(page)).toBe(DESKTOP_GAP);
  });

  test.describe("with a second organization", () => {
    let secondOrgId = "";
    // Unique, so one left behind by a failed clean-up never doubles a row.
    let secondOrg = "";

    test.beforeEach(async () => {
      secondOrg = `${SECOND_ORG_NAME} ${Date.now()}`;
      secondOrgId = await addTestOrganization(
        PERSISTENT_TEST_USER_EMAIL,
        secondOrg
      );
    });

    test.afterEach(async () => {
      if (secondOrgId) {
        await removeTestOrganization(secondOrgId);
        secondOrgId = "";
      }
    });

    test("switching in the drawer updates the header's wallet", async ({
      page,
    }) => {
      // Each organization has its own wallet: the stand-in answers for the
      // one switched to.
      let wallet = STAND_IN_WALLET;
      await page.route("**/api/user/wallet", async (route) => {
        await route.fulfill({
          json: { hasWallet: true, walletAddress: wallet },
        });
      });
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedInHeader(page);
      const home = await orgName(page);
      // Only the icon shows at 320px, so the spoken address tells them apart.
      const address = page.getByTestId("wallet-toolbar-address");
      await expect(address).toHaveAccessibleName(STAND_IN_TAIL_REGEX);
      const trigger = page.getByTestId("mobile-nav-trigger");
      const pick = async (name: string): Promise<void> => {
        await trigger.click();
        await page.getByTestId("mobile-nav-org-switcher").click();
        await page.getByRole("option").filter({ hasText: name }).click();
        await expect(page.getByTestId("mobile-nav")).toHaveCount(0);
        await expect(trigger).toBeFocused();
      };
      // Re-picking the org in use sends nothing: the one request below is
      // the second org's, so none came before it.
      const switches = trackOrgSwitches(page);
      await pick(home);
      wallet = SECOND_WALLET;
      await pick(secondOrg);
      await expect.poll(() => switches).toEqual([secondOrgId]);
      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: `Switched to ${secondOrg}` })
      ).toBeVisible({ timeout: 10_000 });
      await expect(switcherName(page)).toHaveText(secondOrg, {
        timeout: 10_000,
      });
      await expect(address).toHaveAccessibleName(SECOND_TAIL_REGEX, {
        timeout: 10_000,
      });
      // And back.
      wallet = STAND_IN_WALLET;
      await pick(home);
      await expect(switcherName(page)).toHaveText(home, { timeout: 10_000 });
      await expect(address).toHaveAccessibleName(STAND_IN_TAIL_REGEX, {
        timeout: 10_000,
      });
    });

    test("a failed switch says so, changes nothing, and can be tried again", async ({
      page,
    }) => {
      await page.setViewportSize(PHONE);
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedInHeader(page);
      const failSwitch = async (route: Route): Promise<void> => {
        await route.fulfill({ status: 500, json: { message: "unavailable" } });
      };
      await page.route("**/organization/set-active", failSwitch);
      await page.getByTestId("org-switcher").click();
      await page.getByRole("option").filter({ hasText: secondOrg }).click();
      const failed = switchToasts(page).filter({
        hasText: `Couldn't switch to ${secondOrg}.`,
      });
      await expect(failed).toBeVisible({ timeout: 10_000 });
      // Still in the home org.
      await expect(switcherInitials(page)).toHaveText(HOME_INITIALS);
      await page.unroute("**/organization/set-active", failSwitch);
      const tryAgain = failed.getByRole("button", { name: "Try again" });
      // A 36px target on a phone (sonner draws 24px).
      await expect
        .poll(async () => (await tryAgain.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(36);
      // From nowhere, so the toast has no focus to hand back as it goes:
      // the switcher has to take it.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur()
      );
      await tryAgain.click();
      await expect(
        switchToasts(page).filter({ hasText: `Switched to ${secondOrg}` })
      ).toBeVisible({ timeout: 10_000 });
      await expect(switcherName(page)).toHaveText(secondOrg, {
        timeout: 10_000,
      });
      // The toast went with its button: focus is back on the switcher.
      await expect(page.getByTestId("org-switcher")).toBeFocused();
    });

    test("below xs a Try again puts focus on the menu button", async ({
      page,
    }) => {
      // The header's switcher is hidden at 320px; the drawer has one.
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedInHeader(page);
      const failSwitch = async (route: Route): Promise<void> => {
        await route.fulfill({ status: 500, json: { message: "unavailable" } });
      };
      await page.route("**/organization/set-active", failSwitch);
      const trigger = page.getByTestId("mobile-nav-trigger");
      await trigger.click();
      await page.getByTestId("mobile-nav-org-switcher").click();
      await page.getByRole("option").filter({ hasText: secondOrg }).click();
      const failed = switchToasts(page).filter({
        hasText: `Couldn't switch to ${secondOrg}.`,
      });
      await expect(failed).toBeVisible({ timeout: 10_000 });
      await page.unroute("**/organization/set-active", failSwitch);
      // From nowhere, so the toast has no focus to hand back as it goes.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur()
      );
      await failed.getByRole("button", { name: "Try again" }).click();
      await expect(
        switchToasts(page).filter({ hasText: `Switched to ${secondOrg}` })
      ).toBeVisible({ timeout: 10_000 });
      await expect(trigger).toBeFocused();
    });

    test("below lg a touch screen's list wraps names and fits the screen; from lg it is the desktop list", async ({
      page,
    }) => {
      // Short, as a tablet turned sideways with its keyboard up.
      await page.setViewportSize({ width: 820, height: 300 });
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedInHeader(page);
      const popover = page.locator('[data-slot="popover-content"]');
      const name = page
        .getByRole("option")
        .filter({ hasText: secondOrg })
        .locator("span.truncate");
      // Shown only on hover, which a touch screen has none of.
      const gear = page.locator(`[aria-label="Settings for ${secondOrg}"]`);
      // The list fits the room below the switcher below lg (it shrinks and
      // scrolls inside the popover), and is uncapped by it from lg.
      const popoverCap = async (): Promise<string> =>
        await popover.evaluate(
          (element) => getComputedStyle(element).maxHeight
        );

      await page.getByTestId("org-switcher").click();
      await expect(name).toHaveCSS("white-space", "normal");
      await expect(gear).toBeHidden();
      // The current organization's gear is a 26px target.
      const homeGear = page.locator(`[aria-label="Settings for ${HOME_ORG}"]`);
      for (const side of ["width", "height"] as const) {
        await expect
          .poll(async () => (await homeGear.boundingBox())?.[side] ?? 0)
          .toBeGreaterThanOrEqual(26);
      }
      // Read once the list has been placed: its cap depends on the room.
      await expect
        .poll(async () => Number.parseFloat(await popoverCap()))
        .toBeLessThan(300);
      await page.keyboard.press("Escape");

      // Shorter still than both rows: the list scrolls inside the popover,
      // and its last row can be reached.
      await page.setViewportSize({ width: 820, height: 150 });
      await page.getByTestId("org-switcher").click();
      const list = page.locator('[data-slot="command-list"]');
      await expect
        .poll(() =>
          list.evaluate(
            (element) => element.scrollHeight > element.clientHeight
          )
        )
        .toBe(true);
      // Measured once the popover has opened (it scales in), both at once.
      await popover.evaluate((element) =>
        Promise.all(element.getAnimations().map((motion) => motion.finished))
      );
      const [listBottom, popoverBottom] = await list.evaluate((element) => [
        element.getBoundingClientRect().bottom,
        (
          element.closest('[data-slot="popover-content"]') ?? element
        ).getBoundingClientRect().bottom,
      ]);
      expect(listBottom).toBeLessThanOrEqual(popoverBottom + 0.5);
      // It scrolls (not clips): scrolled by the wheel, it reaches its end,
      // where the last row's foot shows. (A long name wraps, so the row can
      // be taller than the list.)
      await expect(list).toHaveCSS("overflow-y", "auto");
      const listBox = await list.boundingBox();
      await page.mouse.move(
        (listBox?.x ?? 0) + (listBox?.width ?? 0) / 2,
        (listBox?.y ?? 0) + (listBox?.height ?? 0) / 2
      );
      await page.mouse.wheel(0, 500);
      await expect
        .poll(() =>
          list.evaluate(
            (element) =>
              element.scrollTop + element.clientHeight >=
              element.scrollHeight - 1
          )
        )
        .toBe(true);
      const [lastRowBottom, listEnd] = await list.evaluate((element) => {
        const rows = [...element.querySelectorAll('[role="option"]')];
        return [
          rows.at(-1)?.getBoundingClientRect().bottom ??
            Number.POSITIVE_INFINITY,
          element.getBoundingClientRect().bottom,
        ];
      });
      expect(lastRowBottom).toBeLessThanOrEqual(listEnd + 0.5);
      await expect(page.getByRole("option").last()).toBeInViewport();
      await page.keyboard.press("Escape");

      await page.setViewportSize({ width: 1280, height: 300 });
      await page.getByTestId("org-switcher").click();
      await expect(name).toHaveCSS("white-space", "nowrap");
      // Still a touch screen: another org's gear (shown only on hover) stays
      // out of the way of a tap on its row at every width.
      await expect(gear).toBeHidden();
      await expect.poll(popoverCap).toBe("none");

      // On desktop too, re-picking the org in use only closes the list;
      // another org switches, without a toast (its name shows).
      const switches = trackOrgSwitches(page);
      await page.getByRole("option").filter({ hasText: HOME_ORG }).click();
      await expect(page.getByRole("option")).toHaveCount(0);
      await page.getByTestId("org-switcher").click();
      await page.getByRole("option").filter({ hasText: secondOrg }).click();
      await expect.poll(() => switches).toEqual([secondOrgId]);
      await expect(switcherName(page)).toHaveText(secondOrg, {
        timeout: 10_000,
      });
      // Named, so a stray toast says which it was.
      expect(await switchToasts(page).allTextContents()).toEqual([]);
    });
  });
});

test.describe("Desktop header", () => {
  test("a 768-1023px window with a mouse shows the switcher while it offers an org", async ({
    page,
  }) => {
    // No org active, and opening the first fails: the header's switcher,
    // hidden at this width with a mouse, comes back to offer it again.
    const noActiveOrg = async (route: Route): Promise<void> => {
      await route.fulfill({ json: null });
    };
    const failSwitch = async (route: Route): Promise<void> => {
      await route.fulfill({ status: 500, json: { message: "unavailable" } });
    };
    await page.route("**/organization/get-full-organization**", noActiveOrg);
    await page.route("**/organization/set-active", failSwitch);
    await page.setViewportSize({ width: 820, height: 800 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    // The mouse layout: the sidebar, no phone menu.
    await expect(page.getByTestId("navigation-sidebar")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
    // Whichever org is listed first.
    const offer = page.getByRole("button", { name: TRY_OPEN_REGEX });
    await expect(offer).toBeVisible({ timeout: 15_000 });
    // It opens: the switcher goes back to being hidden at this width.
    await page.unroute("**/organization/get-full-organization**", noActiveOrg);
    await page.unroute("**/organization/set-active", failSwitch);
    await offer.click();
    // It opened (the switcher shows an org, though hidden), then hid again.
    await expect(page.getByTestId("org-switcher")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 10_000 }
    );
    await expect(page.getByTestId("org-switcher")).toBeHidden();
    await expect(offer).toHaveCount(0);
  });

  test("offers to load the org when it could not be loaded, and then shows it", async ({
    page,
  }) => {
    const unavailable = async (route: Route): Promise<void> => {
      await route.fulfill({ status: 503, json: { message: "unavailable" } });
    };
    await page.route("**/organization/get-full-organization**", unavailable);
    const switches = trackOrgSwitches(page);
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    const load = page.getByRole("button", {
      name: "Load organization, try again",
    });
    await expect(load).toBeVisible({ timeout: 15_000 });
    // It never opened an org itself: the user may be in another.
    expect(switches).toEqual([]);
    await page.unroute("**/organization/get-full-organization**", unavailable);
    await load.click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Loaded your organization" })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("org-switcher")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 10_000 }
    );
    await expect(switcherInitials(page)).toHaveText(HOME_INITIALS);
  });

  test("the desktop header has the sidebar, the name and the plain label", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await expect(page.getByTestId("navigation-sidebar")).toBeVisible();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
    await expect(switcherName(page)).toBeVisible();
    await expect(switcherInitials(page)).toBeHidden();
    await expect(page.getByTestId("org-switcher")).toHaveAttribute(
      "aria-label",
      "Switch organization"
    );
    expect(await headerGap(page)).toBe(DESKTOP_GAP);
  });

  test("a failed New Workflow from the sidebar says so and goes home", async ({
    page,
  }) => {
    await page.route("**/api/workflows/create", async (route) => {
      await route.fulfill({ status: 500, json: { error: "unavailable" } });
    });
    await page.setViewportSize(DESKTOP);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    await page.getByTestId("nav-new").click();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Failed to create workflow" })
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });

  test("a 768-1023px window with a mouse has the org in the avatar menu", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedInHeader(page);
    // No switcher in the header, and the desktop header's spacing.
    await expect(page.getByTestId("org-switcher")).toBeHidden();
    expect(await headerGap(page)).toBe(DESKTOP_GAP);
    for (const [width, has] of [
      [767, false],
      [768, true],
      [1023, true],
      [1024, false],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      expect(await avatarMenuHasOrg(page), `org item at ${width}px`).toBe(has);
    }
  });
});

test.describe("Mobile header, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a visitor gets the drawer, and account-only items ask to sign in", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedOutHeader(page);
    await expect(page.getByTestId("org-switcher")).toHaveCount(0);

    const trigger = page.getByTestId("mobile-nav-trigger");
    const signIn = page.getByRole("dialog", { name: "Sign in to KeeperHub" });
    for (const id of ["analytics", "workflows"]) {
      await trigger.click();
      await expect(page.getByTestId("mobile-nav")).toBeVisible();
      // Owner-only items are not listed for a visitor.
      await expect(page.getByTestId("mobile-nav-held-payments")).toHaveCount(0);
      await page.getByTestId(`mobile-nav-${id}`).click();
      await expect(signIn).toBeVisible();
      await expect(page.getByTestId("mobile-nav")).toHaveCount(0);
      // Dismissing the prompt leaves the page usable: the drawer opens again.
      await page.keyboard.press("Escape");
      await expect(signIn).toHaveCount(0);
    }
    await expect(page).not.toHaveURL(ANALYTICS_URL_REGEX);
  });

  test("a visitor's New Workflow opens their one workflow the second time", async ({
    page,
  }) => {
    // In the sidebar: the first makes the visitor's workflow, the next opens
    // it and says why.
    await page.setViewportSize(DESKTOP);
    await page.goto("/hub", { waitUntil: "domcontentloaded" });
    await waitForSignedOutHeader(page);
    const [created] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().endsWith("/api/workflows/create") &&
          res.request().method() === "POST"
      ),
      page.getByTestId("nav-new").click(),
    ]);
    expect(created.ok(), "create workflow").toBe(true);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBeTruthy();
    try {
      await page.waitForURL(`**/workflows/${id}`);
      const capped = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Sign in to create more workflows." });
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedOutHeader(page);
      await page.getByTestId("nav-new").click();
      await expect(capped).toHaveCount(1, { timeout: 15_000 });
      await page.waitForURL(`**/workflows/${id}`);
      // The same from the phone's drawer.
      await page.setViewportSize(PHONE);
      await page.goto("/hub", { waitUntil: "domcontentloaded" });
      await waitForSignedOutHeader(page);
      await page.getByTestId("mobile-nav-trigger").click();
      await page.getByTestId("mobile-nav-new").click();
      await expect(capped).toHaveCount(1, { timeout: 15_000 });
      await page.waitForURL(`**/workflows/${id}`);
    } finally {
      await deleteTestWorkflow(id);
    }
  });
});
