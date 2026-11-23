import type { Locator, Page } from "@playwright/test";
import {
  READ_ONLY_LABEL,
  VIEWER_DISABLED_REASON,
} from "@/lib/organization/role-label";
import { VIEWER_READ_ONLY_ERROR } from "@/lib/security/viewer-policy";
import {
  PREVIEW_LABEL,
  USE_TEMPLATE_LABEL,
} from "@/lib/workflow/use-template-copy";
import { createWebhookTriggerNode } from "../../fixtures/workflows";
import { expect, test } from "./fixtures";
import {
  addTestOrganization,
  addTestOrganizationViewer,
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_BYSTANDER_EMAIL,
  PERSISTENT_INVITER_EMAIL,
  PERSISTENT_TEST_USER_EMAIL,
  removeTestOrganization,
} from "./utils/db";
import {
  type Box,
  bottom,
  dismissPhoneOverlays,
  horizontalOverflow,
  isOnTop,
  overlaps,
  right,
  box as sharedBox,
  textFits,
} from "./utils/layout";

// Use template on a public workflow someone else owns: a bar across the
// bottom of the free canvas, never in the header, never on other controls.
const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const WIDE_WIDTHS = [768, 1024, 1280, 1920] as const;
const HEIGHT = 844;

// Short timeout: these run inside toPass.
const box = (locator: Locator): Promise<Box> =>
  sharedBox(locator, { timeout: 1000 });

const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  right(inner) <= right(outer) + 0.5 &&
  bottom(inner) <= bottom(outer) + 0.5;

function templateButton(page: Page): Locator {
  return page.getByRole("button", { name: USE_TEMPLATE_LABEL, exact: true });
}

function headerButton(page: Page): Locator {
  return page
    .getByTestId("header-right")
    .getByRole("button", { name: USE_TEMPLATE_LABEL, exact: true });
}

function card(page: Page): Locator {
  return page.getByTestId("use-template-card");
}

const MENU_ITEMS = ["Add Step", "New Workflow from JSON"] as const;
function menuItem(page: Page, name: string): Locator {
  return page.getByRole("button", { name, exact: true });
}

// The nearest empty-canvas point up and left of (x, y), so a right-click
// there reaches the pane and not a node, control or toast.
async function paneNear(
  page: Page,
  x: number,
  y: number
): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(
    ([px, py]) => {
      for (let d = 0; d <= 80; d += 4) {
        for (const [cx, cy] of [
          [px - d, py],
          [px, py - d],
        ]) {
          if (
            document
              .elementFromPoint(cx, cy)
              ?.classList.contains("react-flow__pane")
          ) {
            return { x: cx, y: cy };
          }
        }
      }
      return null;
    },
    [x, y]
  );
  expect(found, `empty canvas near ${x},${y}`).not.toBeNull();
  return found as { x: number; y: number };
}

// Your own workflow; returns its actions, a bottom bar below 768px (from
// 768px they sit in the header with no box of their own).
async function openOwn(
  page: Page,
  width: number,
  height: number,
  id: string
): Promise<Locator> {
  await visit(page, width, height, id);
  const bar = page.getByTestId("workflow-actions");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  return bar;
}

async function visit(
  page: Page,
  width: number,
  height: number,
  id: string
): Promise<void> {
  await dismissPhoneOverlays(page);
  await page.setViewportSize({ width, height });
  await page.goto(`/workflows/${id}`, { waitUntil: "domcontentloaded" });
}

// panel: the right panel's saved width (%) or collapsed state.
async function open(
  page: Page,
  width: number,
  id: string,
  panel?: { width?: number; collapsed?: boolean }
): Promise<void> {
  // The page writes these back, so drop the last open()'s panel first.
  await page.context().clearCookies({ name: /^sidebar-(width|collapsed)$/ });
  const url = process.env.BASE_URL || "http://localhost:3000";
  const cookies = [
    ...(panel?.width
      ? [{ name: "sidebar-width", value: String(panel.width), url }]
      : []),
    ...(panel?.collapsed
      ? [{ name: "sidebar-collapsed", value: "true", url }]
      : []),
  ];
  if (cookies.length > 0) {
    await page.context().addCookies(cookies);
  }
  await visit(page, width, HEIGHT, id);
  await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
}

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

// Every control in the header's left side is clear of the right side's.
async function headerControlsApart(page: Page): Promise<void> {
  const boxesIn = async (testId: string): Promise<Box[]> =>
    await page
      .getByTestId(testId)
      .locator("button:visible, a:visible")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
      );
  const [left, rightSide] = await Promise.all([
    boxesIn("header-left"),
    boxesIn("header-right"),
  ]);
  for (const a of left) {
    for (const b of rightSide) {
      expect(await overlaps(a, b)).toBe(false);
    }
  }
}

// The button, and the badge when shown, inside the card; the card clear of
// the zoom controls (and minimap) and of the header; no sideways scroll.
async function expectCardSound(page: Page): Promise<Box> {
  const button = templateButton(page);
  await expect(
    page.getByTestId("header-left").getByRole("button", {
      name: USE_TEMPLATE_LABEL,
      exact: true,
    })
  ).toHaveCount(0);
  const [cardBox, buttonBox, controls, header] = await Promise.all([
    box(card(page)),
    box(button),
    box(page.locator(".workflow-controls-panel")),
    box(page.getByTestId("header-right")),
  ]);
  expect(inside(buttonBox, cardBox)).toBe(true);
  const badge = card(page).getByText(PREVIEW_LABEL, { exact: true });
  if (await badge.isVisible()) {
    expect(inside(await box(badge), cardBox)).toBe(true);
  }
  expect(await overlaps(cardBox, controls)).toBe(false);
  expect(cardBox.y).toBeGreaterThan(bottom(header));
  expect(bottom(cardBox)).toBeLessThanOrEqual(HEIGHT - 16 + 0.5);
  expect(await isOnTop(button, { corners: true })).toBe(true);
  expect(await textFits(button)).toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await headerControlsApart(page);
  return cardBox;
}

async function expectPhoneBar(page: Page, width: number): Promise<void> {
  const cardBox = await expectCardSound(page);
  expect(cardBox.x).toBeGreaterThanOrEqual(12);
  expect(right(cardBox)).toBeLessThanOrEqual(width - 12);
}

// From md the card is centred on the canvas left free between the sidebar
// (with any open flyout) and the right panel, 16px inside it. Only where
// that canvas is narrower than the card (a flyout over it) may the card give
// way, and then the header offers the button, with the read-only badge.
async function expectWideBar(
  page: Page,
  { allowFallback = false } = {}
): Promise<void> {
  const fallback = headerButton(page);
  if (allowFallback && !(await card(page).isVisible())) {
    await expect(fallback).toBeVisible();
    await expect(templateButton(page)).toHaveCount(1);
    const badge = page
      .getByTestId("header-right")
      .getByText(PREVIEW_LABEL, { exact: true });
    await expect(badge).toBeVisible();
    // The badge is a pill (its rounded corners miss hit tests): its centre only.
    expect(await isOnTop(badge)).toBe(true);
    expect(await textFits(badge)).toBe(true);
    expect(await isOnTop(fallback, { corners: true })).toBe(true);
    expect(await textFits(fallback)).toBe(true);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await headerControlsApart(page);
    return;
  }
  await expect(templateButton(page)).toBeVisible();
  await expect(fallback).toHaveCount(0);
  const cardBox = await expectCardSound(page);
  const canvas = await box(page.getByTestId("workflow-canvas"));
  const navEdge = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Number.parseFloat(
      style.getPropertyValue("--nav-content-offset") ||
        style.getPropertyValue("--nav-sidebar-width")
    );
  });
  expect(Number.isFinite(navEdge)).toBe(true);
  const freeLeft = navEdge + 16;
  const freeRight = right(canvas) - 16;
  expect(cardBox.x).toBeGreaterThanOrEqual(freeLeft - 0.5);
  expect(right(cardBox)).toBeLessThanOrEqual(freeRight + 0.5);
  const middle = (freeLeft + freeRight) / 2;
  expect(Math.abs(cardBox.x + cardBox.width / 2 - middle)).toBeLessThan(2);
}

test.describe("Use template bar, signed in", () => {
  const ids: string[] = [];
  let foreignId = "";
  let ownId = "";
  let ownTriggerId = "";
  let copyableId = "";

  test.beforeAll(async () => {
    foreignId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar source",
        hub: {},
      })
    ).id;
    ownId = (
      await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name: "Use template bar own",
        hub: {},
      })
    ).id;
    // A trigger alone: copying it needs no paid plan.
    copyableId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar copyable",
        hub: {},
        nodes: [createWebhookTriggerNode()],
        edges: [],
      })
    ).id;
    // No paid step, so no paid-features toast near the bottom.
    ownTriggerId = (
      await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name: "Use template bar own trigger",
        nodes: [createWebhookTriggerNode()],
        edges: [],
      })
    ).id;
    ids.push(foreignId, ownId, ownTriggerId, copyableId);
  });

  test.afterAll(async () => {
    for (const id of ids) {
      await deleteTestWorkflow(id);
    }
  });

  test("phones: at the bottom of the screen, header clear", async ({
    page,
  }) => {
    await open(page, PHONE_WIDTHS[0], foreignId);
    for (const width of PHONE_WIDTHS) {
      await atWidth(page, width, () => expectPhoneBar(page, width));
    }
  });

  test("from 768px: centred on the free canvas, clear of the controls", async ({
    page,
  }) => {
    await open(page, WIDE_WIDTHS[0], foreignId);
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () => expectWideBar(page));
    }
  });

  // The card lifts the zoom controls only where it comes near them.
  test("the zoom controls go up only when the card comes near them", async ({
    page,
  }) => {
    const controlsBottom = async (): Promise<number> =>
      bottom(await box(page.locator(".workflow-controls-panel")));
    // 1920px, right panel collapsed: the card is far from the controls.
    await open(page, 1920, foreignId, { collapsed: true });
    await expect(card(page)).toBeVisible();
    await expect(async () => {
      expect(await controlsBottom()).toBeGreaterThan(HEIGHT - 40);
    }).toPass({ timeout: 3000 });
    // At 1024px the minimap beside them reaches under the card: up they go.
    await page.setViewportSize({ width: 1024, height: HEIGHT });
    await page.getByTitle("Show minimap").click();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    await atWidth(page, 1024, async () => {
      await expectWideBar(page);
      expect(await controlsBottom()).toBeLessThan(HEIGHT - 60);
    });
    // Hidden again, the minimap no longer reaches: back down.
    await page.getByTitle("Hide minimap").click();
    await expect(async () => {
      expect(await controlsBottom()).toBeGreaterThan(HEIGHT - 40);
    }).toPass({ timeout: 3000 });
  });

  // Collapsing or reopening the right panel resizes the canvas over 300ms,
  // sliding the controls without resizing them: the lift must follow.
  test("collapsing and reopening the right panel re-measures the controls' lift", async ({
    page,
  }) => {
    await open(page, 1024, foreignId, { width: 50 });
    const controls = page.locator(".workflow-controls-panel");
    const clear = async (): Promise<void> => {
      expect(await overlaps(await box(controls), await box(card(page)))).toBe(
        false
      );
    };
    await expect(clear).toPass({ timeout: 3000 });
    await page.keyboard.press("ControlOrMeta+b");
    await expect(async () => {
      expect(bottom(await box(controls))).toBeGreaterThan(HEIGHT - 40);
    }).toPass({ timeout: 3000 });
    await page.keyboard.press("ControlOrMeta+b");
    // Well past the 300ms slide; without the fix nothing re-measures at all.
    await expect(clear).toPass({ timeout: 1500 });
  });

  test("from 768px: a 50% right panel and the minimap", async ({ page }) => {
    await open(page, WIDE_WIDTHS[0], foreignId, { width: 50 });
    await page.getByTitle("Show minimap").click();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () => expectWideBar(page));
    }
  });

  test("from 768px: with the Workflows flyout open", async ({ page }) => {
    await open(page, WIDE_WIDTHS[0], foreignId);
    const flyout = page.getByRole("region", { name: "Workflows" });
    if (!(await flyout.isVisible())) {
      await page.getByTestId("nav-workflows").click();
    }
    await expect(flyout).toBeVisible();
    // 768 with the flyout leaves no room: once the card gives way, the header
    // has the button.
    await expect(card(page)).toBeHidden();
    await expect(headerButton(page)).toBeVisible();
    for (const width of WIDE_WIDTHS) {
      await atWidth(page, width, () =>
        expectWideBar(page, { allowFallback: true })
      );
    }
    // 768 with the flyout leaves about 58px of canvas: the header takes over,
    // and the zoom controls drop back to the bottom.
    await atWidth(page, 768, async () => {
      await expect(card(page)).toBeHidden();
      await expect(headerButton(page)).toBeVisible();
      const controls = await box(page.locator(".workflow-controls-panel"));
      expect(bottom(controls)).toBeGreaterThan(HEIGHT - 40);
    });
  });

  // However little canvas the flyout and the right panel leave, "Preview"
  // shows once from 768px: in the card, or in the header beside the card's
  // button or beside the header's.
  test("from 768px: the read-only badge is always on screen", async ({
    page,
  }) => {
    // Set once a canvas too narrow for the card's badge is reached.
    let badgeBesideCard = false;
    for (const panel of [{ collapsed: true }, { width: 30 }, { width: 50 }]) {
      await open(page, 1024, foreignId, panel);
      const flyout = page.getByRole("region", { name: "Workflows" });
      if (!(await flyout.isVisible())) {
        await page.getByTestId("nav-workflows").click();
      }
      await expect(flyout).toBeVisible();
      for (const width of [768, 1024, 1280]) {
        await atWidth(page, width, async () => {
          const badges = page
            .getByText(PREVIEW_LABEL, { exact: true })
            .filter({ visible: true });
          await expect(badges).toHaveCount(1);
          expect(await isOnTop(badges)).toBe(true);
          await expect(
            page
              .getByRole("button", { name: USE_TEMPLATE_LABEL })
              .filter({ visible: true })
          ).toHaveCount(1);
          badgeBesideCard ||=
            (await card(page).isVisible()) &&
            (await page
              .getByTestId("header-right")
              .getByText(PREVIEW_LABEL, { exact: true })
              .isVisible());
        });
      }
    }
    expect(badgeBesideCard).toBe(true);
  });

  // A first toast, with none up before it, is lifted too.
  test("the first toast on a page sits above the bar", async ({ page }) => {
    await page.route("**/api/workflows/*/duplicate", (route) =>
      route.fulfill({ status: 500, body: "{}" })
    );
    // A trigger alone raises no paid-features toast on load.
    await open(page, 1024, copyableId, { collapsed: true });
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await templateButton(page).click();
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Failed to duplicate workflow" });
    await expect(toast).toBeVisible();
    await expect(async () => {
      expect(await overlaps(await box(toast), await box(card(page)))).toBe(
        false
      );
    }).toPass({ timeout: 3000 });
  });

  test("keyboard focus follows the button between bar and header", async ({
    page,
  }) => {
    await open(page, 1024, foreignId);
    const flyout = page.getByRole("region", { name: "Workflows" });
    if (!(await flyout.isVisible())) {
      await page.getByTestId("nav-workflows").click();
    }
    await expect(flyout).toBeVisible();
    const inBar = card(page).getByRole("button", {
      name: USE_TEMPLATE_LABEL,
      exact: true,
    });
    await expect(inBar).toBeVisible();
    await inBar.focus();
    await page.setViewportSize({ width: 768, height: HEIGHT });
    await expect(headerButton(page)).toBeFocused();
    await page.setViewportSize({ width: 1024, height: HEIGHT });
    await expect(inBar).toBeFocused();
  });

  // A failed copy toasts every time; with the right panel collapsed the
  // toast (bottom right) is over the canvas, where the bar is.
  test("a toast sits above the bar", async ({ page }) => {
    await page.route("**/api/workflows/*/duplicate", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ status: 500, body: "{}" });
    });
    await open(page, 390, foreignId, { collapsed: true });
    for (const width of [390, 768, 1024, 1920]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: HEIGHT });
        await templateButton(page).click();
        // While it imports the button keeps its name and says it is busy.
        await expect(templateButton(page)).toHaveAttribute("aria-busy", "true");
        // The newest toast is the one in front of the stack.
        const toast = page
          .locator('[data-sonner-toast][data-front="true"]')
          .filter({ hasText: "Failed to duplicate workflow" });
        await expect(toast).toBeVisible();
        await expect(async () => {
          const cardBox = await box(card(page));
          for (const shown of await page
            .locator("[data-sonner-toast]:visible")
            .all()) {
            expect(await overlaps(await box(shown), cardBox)).toBe(false);
          }
        }).toPass({ timeout: 3000 });
      });
    }
  });

  // Over the right panel a toast cannot reach the bar, so it stays put.
  test("a toast over the right panel is not lifted", async ({ page }) => {
    await page.route("**/api/workflows/*/duplicate", (route) =>
      route.fulfill({ status: 500, body: "{}" })
    );
    await open(page, 1280, foreignId);
    await templateButton(page).click();
    const toast = page
      .locator('[data-sonner-toast][data-front="true"]')
      .filter({ hasText: "Failed to duplicate workflow" });
    await expect(toast).toBeVisible();
    await expect(async () => {
      expect(bottom(await box(toast))).toBeGreaterThan(HEIGHT - 40);
    }).toPass({ timeout: 3000 });
  });

  test("copies the workflow and opens the copy", async ({ page }) => {
    await open(page, 1280, copyableId);
    const duplicated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/workflows/${copyableId}/duplicate`)
    );
    await templateButton(page).click();
    const response = await duplicated;
    expect(response.ok()).toBe(true);
    const copy = (await response.json()) as { id: string };
    ids.push(copy.id);
    await expect(page).toHaveURL(new RegExp(`/workflows/${copy.id}`), {
      timeout: 15_000,
    });
    await expect(page.getByTestId("workflow-actions")).toBeVisible({
      timeout: 15_000,
    });
    await expect(card(page)).toHaveCount(0);
    // Back on the source, the button the copy started from does not grab
    // focus on its own.
    await page.goBack();
    await expect(templateButton(page)).toBeVisible({ timeout: 15_000 });
    await page.setViewportSize({ width: 1024, height: HEIGHT });
    await expect(templateButton(page)).toBeVisible();
    await expect(templateButton(page)).not.toBeFocused();
  });

  test("not shown on your own workflow", async ({ page }) => {
    for (const width of [390, 1280]) {
      await openOwn(page, width, HEIGHT, ownId);
      await expect(card(page)).toHaveCount(0);
      if (width >= 768) {
        // No bar, so the zoom controls keep their place at the bottom.
        await expect(page.locator(".workflow-controls-panel")).toBeVisible();
        const controls = await box(page.locator(".workflow-controls-panel"));
        expect(bottom(controls)).toBeGreaterThan(HEIGHT - 40);
      }
    }
  });

  test("no canvas menu on a workflow you cannot edit", async ({ page }) => {
    await open(page, 1280, foreignId);
    const cardBox = await box(card(page));
    const spot = await paneNear(
      page,
      cardBox.x + cardBox.width / 2,
      cardBox.y - 12
    );
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await expect(templateButton(page)).toBeVisible();
    await expect(menuItem(page, "Add Step")).toHaveCount(0);
    // The same right-click on your own workflow does open it.
    await openOwn(page, 1280, HEIGHT, ownTriggerId);
    const own = await paneNear(page, spot.x, spot.y);
    await page.mouse.click(own.x, own.y, { button: "right" });
    await expect(menuItem(page, "Add Step")).toBeVisible();
  });

  for (const width of [390, 700]) {
    test(`${width}px: the right-click menu is drawn over the owner's bottom bar`, async ({
      page,
    }) => {
      const bar = await box(await openOwn(page, width, HEIGHT, ownTriggerId));
      // Low enough to reach the bar, high enough not to flip up.
      const spot = await paneNear(page, bar.x + 8, bar.y - 40);
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      const items = MENU_ITEMS.map((name) => menuItem(page, name));
      await expect(items[1]).toBeVisible();
      expect(await overlaps(items[1], bar)).toBe(true);
      for (const item of items) {
        expect(await isOnTop(item, { corners: true })).toBe(true);
      }
    });
  }
});

// The signed-in user reads an org as a viewer: it may not copy into it.
test.describe("Use template bar, org viewer", () => {
  test.describe.configure({ mode: "serial" });
  let orgId = "";
  let foreignId = "";
  let inOrgId = "";

  test.beforeAll(async () => {
    orgId = await addTestOrganization(
      PERSISTENT_BYSTANDER_EMAIL,
      "Use template viewer org"
    );
    foreignId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template viewer source",
        hub: {},
      })
    ).id;
    inOrgId = (
      await createTestWorkflow(PERSISTENT_BYSTANDER_EMAIL, {
        name: "Use template viewer in org",
        hub: {},
      })
    ).id;
    await addTestOrganizationViewer(orgId, PERSISTENT_TEST_USER_EMAIL, inOrgId);
  });

  // Also moves the shared session back to an org the user is still in.
  test.afterAll(async () => {
    await deleteTestWorkflow(foreignId);
    await deleteTestWorkflow(inOrgId);
    await removeTestOrganization(orgId);
  });

  test.beforeEach(async ({ apiRequest }) => {
    const res = await apiRequest.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
    });
    expect(res.ok()).toBe(true);
  });

  test("someone else's public workflow: Use template disabled, the card says why", async ({
    page,
    apiRequest,
  }) => {
    // Phones: no room for the hint, so the badge says it.
    await open(page, 390, foreignId);
    await expect(templateButton(page)).toBeDisabled();
    const cardBadge = card(page).getByText(READ_ONLY_LABEL, { exact: true });
    await expect(cardBadge).toBeVisible();
    await expect(cardBadge).toHaveAttribute("title", VIEWER_DISABLED_REASON);
    await open(page, 1280, foreignId);
    await expect(templateButton(page)).toBeDisabled();
    await expect(card(page)).toContainText(VIEWER_DISABLED_REASON);
    await expect(card(page)).not.toContainText("Make your own copy");
    await templateButton(page).locator("..").hover();
    await expect(page.getByRole("tooltip")).toContainText(
      VIEWER_DISABLED_REASON
    );
    // The server is the gate, not the disabled button.
    const res = await apiRequest.post(`/api/workflows/${foreignId}/duplicate`, {
      data: {},
    });
    expect(res.status()).toBe(403);
    // The viewer rule, not the cross-site check, which is a 403 too.
    expect((await res.json()).code).toBe(VIEWER_READ_ONLY_ERROR.code);
  });

  test("a public workflow in that org: Read only badge, no Use template", async ({
    page,
  }) => {
    for (const width of [390, 1280]) {
      await visit(page, width, HEIGHT, inOrgId);
      const badge = page.getByTestId("workflow-read-only-badge");
      await expect(badge).toBeVisible({ timeout: 15_000 });
      await expect(badge).toContainText(READ_ONLY_LABEL);
      await expect(badge).toHaveAttribute("title", VIEWER_DISABLED_REASON);
      await expect(card(page)).toHaveCount(0);
      await expect(templateButton(page)).toHaveCount(0);
    }
  });
});

test.describe("Use template bar, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let foreignId = "";

  test.beforeAll(async () => {
    foreignId = (
      await createTestWorkflow(PERSISTENT_INVITER_EMAIL, {
        name: "Use template bar visitor",
        hub: {},
      })
    ).id;
  });

  test.afterAll(async () => {
    if (foreignId) {
      await deleteTestWorkflow(foreignId);
    }
  });

  test("phones: the bar opens the sign-in window", async ({ page }) => {
    await open(page, 390, foreignId);
    await expectPhoneBar(page, 390);
    await templateButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await isOnTop(page.getByRole("dialog"))).toBe(true);
  });
});
