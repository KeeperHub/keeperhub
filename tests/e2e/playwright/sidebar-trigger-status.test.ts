import type { Locator, Page } from "@playwright/test";
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
    const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
      name: `trigger-status-switch-${Date.now()}`,
      triggerType: "schedule",
      cronExpression: "0 * * * *",
      enabled: true,
    });
    created.push(workflow.id);

    await page.goto(`/workflows/${workflow.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForCanvas(page);
    await openWorkflowPicker(page, workflow.name);

    const icon = pickerRow(page, workflow.name).getByTestId(
      "trigger-status-icon"
    );
    await expect(icon).toHaveAttribute("data-trigger-type", "Schedule");
    await expect(icon).toHaveAttribute("data-trigger-status", "enabled");

    await page.locator(".react-flow__node-trigger").click();
    await page.locator("#triggerType").click();
    await page.getByRole("option", { name: "Manual" }).click();

    // The row follows only once the edit is saved: a 2.5s autosave debounce
    // plus the request, so allow more than the default 5s.
    await expect(icon).toHaveAttribute("data-trigger-type", "Manual", {
      timeout: 10_000,
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

    const liveRow = pickerRow(page, live.name);
    const manualRow = pickerRow(page, manual.name);
    await expect(liveRow).toBeVisible();

    await liveRow.getByTestId("trigger-status-icon").hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Enabled · Schedule trigger · Every 5 minutes"
    );

    await page.getByTestId("trigger-filter-button").click();
    const chip = (value: string): Locator =>
      page.locator(
        `[data-testid="trigger-filter-chips"] [data-filter="${value}"]`
      );
    await expect(chip("all")).toHaveAttribute("aria-pressed", "true");

    await chip("enabled").click();
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toHaveCount(0);

    await chip("manual").click();
    await expect(chip("enabled")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("manual")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("all")).toHaveAttribute("aria-pressed", "false");
    await expect(liveRow).toBeVisible();
    await expect(manualRow).toBeVisible();

    await chip("enabled").click();
    await chip("manual").click();
    await chip("disabled").click();
    await expect(liveRow).toHaveCount(0);
    await expect(manualRow).toHaveCount(0);

    await page.getByTestId("trigger-filter-reset").click();
    await expect(chip("all")).toHaveAttribute("aria-pressed", "true");
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

  test("a project too long for the panel gets a search field", async ({
    page,
    apiRequest,
  }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    const stamp = Date.now();
    const projectResponse = await apiRequest.post("/api/projects", {
      data: { name: `trigger-search-${stamp}` },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as {
      id: string;
      name: string;
    };
    createdProjects.push(project.id);

    const names = Array.from(
      { length: 20 },
      (_, i) => `trigger-search-${stamp}-${i % 2 === 0 ? "alpha" : "beta"}-${i}`
    );
    for (const name of names) {
      const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
        name,
        triggerType: "manual",
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
    await page.getByTestId("trigger-filter-button").click();

    const search = page.getByTestId("workflow-search");
    await expect(search).toBeVisible();
    await page
      .getByTestId("workflow-picker-item")
      .filter({ hasText: `${stamp}-19` })
      .scrollIntoViewIfNeeded();
    await expect(search).toBeInViewport();
    await expect(page.getByTestId("trigger-filter-chips")).toBeInViewport();
    await search.fill("beta");
    await expect(
      page.getByTestId("workflow-picker-item").filter({ hasText: "alpha" })
    ).toHaveCount(0);
    await expect(
      page.getByTestId("workflow-picker-item").filter({ hasText: "beta" })
    ).toHaveCount(10);

    // Escape clears the query first and leaves the panel open.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeVisible();

    await search.fill("no-such-workflow");
    await page.getByTestId("trigger-filter-reset").click();
    await expect(search).toHaveValue("");
    await expect(
      page
        .getByTestId("workflow-picker-item")
        .filter({ hasText: stamp.toString() })
    ).toHaveCount(20);
  });
});
