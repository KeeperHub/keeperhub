import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { dismissPhoneOverlays } from "./utils/layout";
import { waitForCanvas } from "./utils/workflow";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
// Past the drawer's LEVEL_TAP_GRACE_MS (components/mobile-nav.tsx), which
// drops taps right after a level change; a test's next tap waits it out.
const AFTER_TAP_GRACE_MS = 400;
// Long enough for a wrong pick to have navigated and closed the drawer.
const SETTLE_MS = 1000;

function drawer(page: Page): Locator {
  return page.getByTestId("mobile-nav");
}

function levelTitle(page: Page): Locator {
  return page.getByTestId("mobile-nav-level-title");
}

function pickerRow(page: Page, name: string): Locator {
  return drawer(page)
    .getByTestId("workflow-picker-item")
    .filter({ hasText: name });
}

async function tapAfterLevelChange(target: Locator): Promise<void> {
  await target.page().waitForTimeout(AFTER_TAP_GRACE_MS);
  await target.tap();
}

// Waits for the slide-in, so a measured row is where a tap will land.
async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("mobile-nav-trigger").tap();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished))
  );
}

test.describe("Workflows in the phone drawer", () => {
  const created: string[] = [];
  const createdProjects: string[] = [];
  let project: { id: string; name: string };
  let first: { id: string; name: string };
  let second: { id: string; name: string };

  test.beforeEach(async ({ apiRequest }) => {
    const stamp = Date.now();
    const response = await apiRequest.post("/api/projects", {
      data: { name: `drawer-picker-${stamp}` },
    });
    expect(response.ok(), "create project").toBe(true);
    project = (await response.json()) as { id: string; name: string };
    createdProjects.push(project.id);
    first = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `drawer-picker-first-${stamp}`,
      triggerType: "manual",
    });
    second = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `drawer-picker-second-${stamp}`,
      triggerType: "manual",
    });
    created.push(first.id, second.id);
    for (const id of [first.id, second.id]) {
      const moved = await apiRequest.patch(`/api/workflows/${id}`, {
        data: { projectId: project.id },
      });
      expect(moved.ok(), "move workflow into project").toBe(true);
    }
  });

  // Runs even when a test fails part-way through.
  test.afterEach(async ({ apiRequest }) => {
    for (const id of created.splice(0)) {
      await deleteTestWorkflow(id);
    }
    for (const id of createdProjects.splice(0)) {
      const deleted = await apiRequest.delete(`/api/projects/${id}`);
      expect(deleted.ok(), `delete project ${id}`).toBe(true);
    }
  });

  async function openFirstOnPhone(page: Page): Promise<void> {
    await dismissPhoneOverlays(page);
    await page.setViewportSize(PHONE);
    await page.goto(`/workflows/${first.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForCanvas(page);
    await openDrawer(page);
    // The list has loaded once the menu row names the open workflow's project.
    await expect(page.getByTestId("mobile-nav-workflows")).toContainText(
      project.name,
      { timeout: 15_000 }
    );
  }

  test.describe("on a phone", () => {
    test.use({ hasTouch: true });

    test("browses projects and opens another workflow", async ({ page }) => {
      await openFirstOnPhone(page);
      await page.getByTestId("mobile-nav-workflows").tap();

      // Opens on the open workflow's project, with that workflow marked.
      await expect(levelTitle(page)).toHaveText(project.name);
      await expect(levelTitle(page)).toBeFocused();
      await expect(pickerRow(page, first.name)).toHaveAttribute(
        "aria-current",
        "page"
      );
      const rowBox = await pickerRow(page, second.name).boundingBox();
      expect(rowBox?.height).toBe(44);

      // Back shows every project, focusing the one just left.
      await tapAfterLevelChange(page.getByTestId("mobile-nav-back"));
      await expect(levelTitle(page)).toHaveText("Workflows");
      const projectRow = drawer(page).locator(
        `[data-project-id="${project.id}"]`
      );
      await expect(projectRow).toBeFocused();

      await tapAfterLevelChange(projectRow);
      await expect(levelTitle(page)).toHaveText(project.name);
      await tapAfterLevelChange(pickerRow(page, second.name));
      await page.waitForURL(`**/workflows/${second.id}`);
      await expect(drawer(page)).toHaveCount(0);

      // It opens at the menu again.
      await openDrawer(page);
      await expect(levelTitle(page)).toHaveCount(0);
      await expect(page.getByTestId("mobile-nav-workflows")).toBeVisible();
    });

    test("a double tap on Workflows opens nothing it did not show", async ({
      page,
      apiRequest,
    }) => {
      // Enough rows that one lies under the Workflows row's spot on the menu.
      for (let i = 0; i < 4; i += 1) {
        const extra = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
          name: `drawer-picker-extra-${i}-${Date.now()}`,
          triggerType: "manual",
        });
        created.push(extra.id);
        const moved = await apiRequest.patch(`/api/workflows/${extra.id}`, {
          data: { projectId: project.id },
        });
        expect(moved.ok(), "move workflow into project").toBe(true);
      }
      await openFirstOnPhone(page);
      const row = page.getByTestId("mobile-nav-workflows");
      const target = await row.boundingBox();
      if (!target) {
        throw new Error("no Workflows row");
      }
      const x = target.x + target.width / 2;
      const y = target.y + target.height / 2;
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
      await expect(levelTitle(page)).toHaveText(project.name);
      // A row now lies where the second tap landed.
      const under = await page.evaluate(
        ([px, py]) =>
          Boolean(
            document
              .elementFromPoint(px, py)
              ?.closest("[data-testid=workflow-picker-item]")
          ),
        [x, y]
      );
      expect(under).toBe(true);
      // A picked row would close the drawer (data-state flips at once) and
      // navigate once the route loads.
      await expect(drawer(page)).toHaveAttribute("data-state", "open");
      await page.waitForTimeout(SETTLE_MS);
      await expect(drawer(page)).toHaveAttribute("data-state", "open");
      await expect(page).toHaveURL(new RegExp(`/workflows/${first.id}$`));
    });

    test("Escape goes up a level at a time, then closes", async ({ page }) => {
      await openFirstOnPhone(page);
      await page.getByTestId("mobile-nav-workflows").tap();
      await expect(levelTitle(page)).toHaveText(project.name);
      await page.keyboard.press("Escape");
      await expect(levelTitle(page)).toHaveText("Workflows");
      await page.keyboard.press("Escape");
      await expect(levelTitle(page)).toHaveCount(0);
      await expect(page.getByTestId("mobile-nav-workflows")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(drawer(page)).toHaveCount(0);
    });
  });

  test("the sidebar flyouts still list the project on desktop", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`/workflows/${first.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForCanvas(page);
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
    // Each test starts with the flyouts closed.
    await page.getByTestId("nav-workflows").click();
    const panel = page.getByRole("region", { name: "Workflows" });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: project.name })
      .click({ timeout: 15_000 });
    const projectPanel = page.getByRole("region", { name: project.name });
    await expect(
      projectPanel.getByTestId("workflow-picker-item").filter({
        hasText: second.name,
      })
    ).toBeVisible();
  });
});
