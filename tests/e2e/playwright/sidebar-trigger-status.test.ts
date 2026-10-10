import type { Locator, Page } from "@playwright/test";
import { createScheduleTriggerNode } from "../../fixtures/workflows";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_TEST_USER_EMAIL,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

const ENABLE_BUTTON_REGEX = /^(Enable|Disable) workflow$/;

// The Workflows flyout, labelled with its title (FlyoutPanel is a section).
function workflowsPanel(page: Page): Locator {
  return page.getByRole("region", { name: "Workflows" });
}

// Opens the Workflows flyout and waits for the list to load, shown by
// `waitFor`: a workflow outside any project, or a project name.
async function openWorkflowPicker(page: Page, waitFor: string): Promise<void> {
  await expect(page.getByTestId("nav-workflows")).toBeVisible({
    timeout: 15_000,
  });
  // Saved nav state may already have it open; only click when it is not.
  if (!(await workflowsPanel(page).isVisible())) {
    await page.getByTestId("nav-workflows").click();
  }
  await expect(workflowsPanel(page)).toBeVisible();
  await expect(
    workflowsPanel(page).getByRole("button", { name: waitFor }).first()
  ).toBeVisible({ timeout: 15_000 });
}

async function openProject(page: Page, name: string): Promise<void> {
  await workflowsPanel(page).getByRole("button", { name }).click();
}

// A project's flyout, labelled with the project's name. The Workflows flyout
// beside it has a filter of its own, so filter controls are found per panel.
function projectPanel(page: Page, name: string): Locator {
  return page.getByRole("region", { name });
}

// An entry in the open filter menu, by its value ("enabled", "Manual").
function filterMenuItem(page: Page, value: string): Locator {
  return page.locator(`[role="menuitemcheckbox"][data-filter="${value}"]`);
}

async function pickInMenu(page: Page, value: string): Promise<void> {
  await filterMenuItem(page, value).click();
}

// A menu still animating out swallows the next click as an outside click.
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

// An open tooltip covers the controls under it. A hover tooltip closes only on
// a pointer move outside its grace area, so leave in steps for the empty right
// edge; a focus tooltip (focus moves to the filter button once the clear
// button goes) closes on blur.
async function dismissTooltip(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport) {
    await page.mouse.move(viewport.width - 1, viewport.height / 2, {
      steps: 10,
    });
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

function pickerRow(page: Page, name: string): Locator {
  return page.getByTestId("workflow-picker-item").filter({ hasText: name });
}

test.describe("Sidebar trigger status icons", () => {
  const created: string[] = [];
  const createdProjects: string[] = [];

  // Runs even when a test fails part-way through its setup.
  test.afterEach(async ({ apiRequest }) => {
    for (const id of created.splice(0)) {
      await deleteTestWorkflow(id);
    }
    for (const id of createdProjects.splice(0)) {
      const deleted = await apiRequest.delete(`/api/projects/${id}`);
      expect(deleted.ok(), `delete project ${id}`).toBe(true);
    }
  });

  test("shows trigger type, enabled state and cadence per row", async ({
    page,
  }) => {
    const stamp = Date.now();
    const live = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-live-${stamp}`,
      triggerType: "schedule",
      cronExpression: "*/5 * * * *",
      enabled: true,
    });
    const off = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-off-${stamp}`,
      triggerType: "webhook",
      enabled: false,
    });
    const manual = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-manual-${stamp}`,
      triggerType: "manual",
      enabled: false,
    });
    created.push(live.id, off.id, manual.id);

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, live.name);

    const expectations = [
      [live.name, "Schedule", "enabled", "5 min"],
      // Webhook and Manual have nothing to add to their icon.
      [off.name, "Webhook", "disabled", ""],
      [manual.name, "Manual", "manual", ""],
    ] as const;
    for (const [name, type, status, label] of expectations) {
      const row = pickerRow(page, name);
      const icon = row.getByTestId("trigger-status-icon");
      await expect(icon).toHaveAttribute("data-trigger-type", type);
      await expect(icon).toHaveAttribute("data-trigger-status", status);
      await expect(row.getByTestId("workflow-trigger-label")).toHaveText(label);
    }
  });

  test("the open workflow's row follows a trigger change without a reload", async ({
    page,
  }) => {
    // Trigger only: the default action is a paid-plan node, and the free test
    // org would have every autosave of it refused.
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-switch-${Date.now()}`,
      triggerType: "schedule",
      cronExpression: "0 * * * *",
      enabled: true,
      nodes: [createScheduleTriggerNode("0 * * * *")],
      edges: [],
    });
    created.push(workflow.id);

    await page.goto(`/workflows/${workflow.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForCanvas(page);
    // The flyout opens over the canvas, so select the trigger first.
    await page.locator(".react-flow__node-trigger").click();
    await expect(page.locator("#triggerType")).toBeVisible();
    await openWorkflowPicker(page, workflow.name);

    const icon = pickerRow(page, workflow.name).getByTestId(
      "trigger-status-icon"
    );
    await expect(icon).toHaveAttribute("data-trigger-type", "Schedule");
    await expect(icon).toHaveAttribute("data-trigger-status", "enabled");

    await page.locator("#triggerType").click();
    await page.getByRole("option", { name: "Manual" }).click();

    // The row follows only once the edit is saved and the list refetched: a
    // 2.5s autosave debounce, the save and the list request, so allow well
    // more than the default 5s.
    await expect(icon).toHaveAttribute("data-trigger-type", "Manual", {
      timeout: 15_000,
    });
    await expect(icon).toHaveAttribute("data-trigger-status", "manual");
    await expect(
      pickerRow(page, workflow.name).getByTestId("workflow-trigger-label")
    ).toHaveText("");
  });

  test("enabling the open workflow turns its icon green", async ({ page }) => {
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-enable-${Date.now()}`,
      triggerType: "schedule",
      cronExpression: "*/15 * * * *",
      enabled: false,
    });
    created.push(workflow.id);

    await page.goto(`/workflows/${workflow.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForCanvas(page);
    await openWorkflowPicker(page, workflow.name);

    const row = pickerRow(page, workflow.name);
    const icon = row.getByTestId("trigger-status-icon");
    // The column shows the cadence either way; the icon shows the status.
    await expect(icon).toHaveAttribute("data-trigger-status", "disabled");
    await expect(row.getByTestId("workflow-trigger-label")).toHaveText(
      "15 min"
    );

    await page.getByTitle(ENABLE_BUTTON_REGEX).click();

    await expect(icon).toHaveAttribute("data-trigger-status", "enabled");
    await expect(row.getByTestId("workflow-trigger-label")).toHaveText(
      "15 min"
    );
  });

  test("filters combine, reset when empty, and icons name their trigger", async ({
    page,
    apiRequest,
  }) => {
    const stamp = Date.now();
    const projectResponse = await apiRequest.post("/api/projects", {
      data: { name: `trigger-filter-${stamp}` },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as {
      id: string;
      name: string;
    };
    createdProjects.push(project.id);

    const live = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-filter-live-${stamp}`,
      triggerType: "schedule",
      cronExpression: "*/5 * * * *",
      enabled: true,
    });
    const manual = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-filter-manual-${stamp}`,
      triggerType: "manual",
    });
    created.push(live.id, manual.id);
    for (const id of [live.id, manual.id]) {
      const moved = await apiRequest.patch(`/api/workflows/${id}`, {
        data: { projectId: project.id },
      });
      expect(moved.ok()).toBe(true);
    }

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, project.name);
    await openProject(page, project.name);
    const panel = projectPanel(page, project.name);

    const liveRow = pickerRow(page, live.name);
    const manualRow = pickerRow(page, manual.name);
    await expect(liveRow).toBeVisible();

    await liveRow.getByTestId("trigger-status-icon").hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Enabled · Schedule trigger · Every 5 minutes"
    );
    await dismissTooltip(page);

    await panel.getByTestId("trigger-filter-button").click();
    const statusButton = panel.getByTestId("status-filter");
    const typeButton = panel.getByTestId("trigger-type-filter");
    await expect(statusButton).toHaveAccessibleName("Status: All");

    // Status: Enabled.
    await statusButton.click();
    await pickInMenu(page, "enabled");
    await closeMenu(page);
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toHaveCount(0);

    // Picks within a menu add up: Enabled or Manual.
    await statusButton.click();
    await pickInMenu(page, "manual");
    await closeMenu(page);
    await expect(statusButton).toHaveAccessibleName("Status: Enabled, Manual");
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toBeVisible();

    // Across menus they narrow: (Enabled or Manual) and a Manual trigger.
    await typeButton.click();
    const manualType = filterMenuItem(page, "Manual");
    await expect(manualType).toContainText("1");
    await manualType.click();
    await closeMenu(page);
    await expect(liveRow).toHaveCount(0);
    await expect(manualRow).toBeVisible();

    // Nothing left: the empty message offers a way back.
    await typeButton.click();
    await filterMenuItem(page, "Manual").click();
    await filterMenuItem(page, "Schedule").click();
    await closeMenu(page);
    await statusButton.click();
    await pickInMenu(page, "enabled");
    await closeMenu(page);
    await expect(liveRow).toHaveCount(0);
    await expect(manualRow).toHaveCount(0);

    await panel.getByTestId("trigger-filter-reset").click();
    await expect(statusButton).toHaveAccessibleName("Status: All");
    await expect(typeButton).toHaveAccessibleName("Trigger: All");
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toBeVisible();
  });

  test("a cut-off workflow name shows in full on hover", async ({ page }) => {
    const longName = `trigger-status-long-name ${"monitor of a very long bridge invariant ".repeat(2)}${Date.now()}`;
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: longName,
      triggerType: "manual",
    });
    created.push(workflow.id);

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, longName);

    await pickerRow(page, longName).getByText(longName).hover();
    await expect(page.getByRole("tooltip")).toHaveText(longName);
  });

  test("a cut-off event name label shows in full on hover", async ({
    page,
  }) => {
    const eventName = "RateLimitsChangedForAllRemotes";
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-event-${Date.now()}`,
      enabled: true,
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            type: "trigger",
            label: "Event",
            config: { triggerType: "Event", eventName },
          },
        },
      ],
      edges: [],
    });
    created.push(workflow.id);

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, workflow.name);

    const label = pickerRow(page, workflow.name).getByTestId(
      "workflow-trigger-label"
    );
    await expect(label).toHaveText(eventName);
    await label.getByText(eventName).hover();
    await expect(page.getByRole("tooltip")).toHaveText(eventName);
  });

  test("on a long project the filter row stays in view and clears in one click", async ({
    page,
    apiRequest,
  }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    const stamp = Date.now();
    const projectResponse = await apiRequest.post("/api/projects", {
      data: { name: `trigger-long-${stamp}` },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as {
      id: string;
      name: string;
    };
    createdProjects.push(project.id);

    for (let i = 0; i < 20; i += 1) {
      const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name: `trigger-long-${stamp}-${i}`,
        triggerType: i % 2 === 0 ? "manual" : "webhook",
        enabled: false,
      });
      created.push(workflow.id);
      const moved = await apiRequest.patch(`/api/workflows/${workflow.id}`, {
        data: { projectId: project.id },
      });
      expect(moved.ok()).toBe(true);
    }

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, project.name);
    await openProject(page, project.name);
    const panel = projectPanel(page, project.name);
    await panel.getByTestId("trigger-filter-button").click();

    await panel.getByTestId("trigger-type-filter").click();
    await filterMenuItem(page, "Manual").click();
    await closeMenu(page);
    const rows = page
      .getByTestId("workflow-picker-item")
      .filter({ hasText: stamp.toString() });
    await expect(rows).toHaveCount(10);

    await rows.last().scrollIntoViewIfNeeded();
    await expect(panel.getByTestId("trigger-filters")).toBeInViewport();
    await expect(panel.getByTestId("trigger-filter-button")).toHaveAttribute(
      "data-filtered",
      "true"
    );

    await panel.getByTestId("trigger-filter-clear").click();
    await dismissTooltip(page);
    await expect(rows).toHaveCount(20);
    await expect(
      panel.getByTestId("trigger-filter-button")
    ).not.toHaveAttribute("data-filtered", "true");

    // With a filter on, the filter button clears it and hides the row in
    // one go, so the row never hides while it is shortening the list.
    await panel.getByTestId("status-filter").click();
    await pickInMenu(page, "manual");
    await closeMenu(page);
    await expect(rows).toHaveCount(10);
    await panel.getByTestId("trigger-filter-button").click();
    await expect(panel.getByTestId("trigger-filters")).toHaveCount(0);
    await expect(rows).toHaveCount(20);
  });

  test("the Workflows panel filters workflows outside any project and leaves projects alone", async ({
    page,
    apiRequest,
  }) => {
    const stamp = Date.now();
    const projectResponse = await apiRequest.post("/api/projects", {
      data: { name: `root-filter-project-${stamp}` },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as {
      id: string;
      name: string;
    };
    createdProjects.push(project.id);

    const live = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `root-filter-live-${stamp}`,
      triggerType: "schedule",
      cronExpression: "*/5 * * * *",
      enabled: true,
    });
    const manual = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `root-filter-manual-${stamp}`,
      triggerType: "manual",
    });
    const inProject = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `root-filter-in-project-${stamp}`,
      triggerType: "manual",
    });
    created.push(live.id, manual.id, inProject.id);
    const moved = await apiRequest.patch(`/api/workflows/${inProject.id}`, {
      data: { projectId: project.id },
    });
    expect(moved.ok()).toBe(true);

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await openWorkflowPicker(page, live.name);
    const panel = workflowsPanel(page);
    const liveRow = pickerRow(page, live.name);
    const manualRow = pickerRow(page, manual.name);
    const projectButton = panel.getByRole("button", { name: project.name });
    await expect(manualRow).toBeVisible();

    await panel.getByTestId("trigger-filter-button").click();
    await panel.getByTestId("status-filter").click();
    await pickInMenu(page, "enabled");
    await closeMenu(page);

    // Only the workflows outside any project are filtered.
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toHaveCount(0);
    await expect(projectButton).toBeVisible();
    await expect(panel.getByTestId("trigger-filter-button")).toHaveAttribute(
      "data-filtered",
      "true"
    );

    // A project opened beside it starts with its own filter off.
    await openProject(page, project.name);
    const projectFilterButton = projectPanel(page, project.name).getByTestId(
      "trigger-filter-button"
    );
    await expect(projectFilterButton).not.toHaveAttribute(
      "data-filtered",
      "true"
    );
    await expect(pickerRow(page, inProject.name)).toBeVisible();
    await expect(manualRow).toHaveCount(0);

    // With a filter on, the button clears it and hides the row in one go.
    await panel.getByTestId("trigger-filter-button").click();
    await expect(panel.getByTestId("trigger-filters")).toHaveCount(0);
    await expect(manualRow).toBeVisible();
  });
});
