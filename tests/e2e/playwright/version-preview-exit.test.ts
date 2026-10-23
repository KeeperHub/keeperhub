import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createTestWorkflow,
  deleteTestWorkflow,
  PERSISTENT_PRO_EMAIL,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

// The fixture workflow's HTTP Request action is Pro-gated, so saving new
// versions of it needs the seeded pro-plan user.
test.use({ storageState: "tests/e2e/playwright/.auth/pro.json" });

const OLD_LABEL = "Old label";
const LIVE_LABEL = "Live label";
const VERSION_PARAM = /[?&]version=/;
// A cancelled preview shows up as nothing happening, so the negative checks
// give the released response time to reach the canvas and the URL.
const SETTLE_MS = 1000;

type SavedWorkflow = {
  nodes: Array<{ id: string; data: Record<string, unknown> }>;
};

async function saveActionLabel(
  page: Page,
  workflowId: string,
  label: string
): Promise<void> {
  const current = await page.request.get(`/api/workflows/${workflowId}`);
  const workflow = (await current.json()) as SavedWorkflow;
  const nodes = workflow.nodes.map((node) =>
    node.id === "action-1" ? { ...node, data: { ...node.data, label } } : node
  );
  const saved = await page.request.patch(`/api/workflows/${workflowId}`, {
    data: { nodes },
    headers: { origin: "http://localhost:3000" },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

// Version 1 has the old label, version 2 (current) the live one.
async function createVersionedWorkflow(page: Page): Promise<string> {
  const workflow = await createTestWorkflow(PERSISTENT_PRO_EMAIL, {
    name: `version-preview-${Date.now()}`,
    triggerType: "manual",
    enabled: false,
  });
  await saveActionLabel(page, workflow.id, OLD_LABEL);
  await saveActionLabel(page, workflow.id, LIVE_LABEL);
  return workflow.id;
}

function isVersionRequest(
  request: Request,
  workflowId: string,
  version: number
): boolean {
  const url = new URL(request.url());
  return (
    url.pathname === `/api/workflows/${workflowId}` &&
    url.searchParams.get("version") === String(version)
  );
}

// Holds the versioned workflow request until release() is called, so a test
// can change tabs while the preview is still loading.
async function holdVersionRequest(
  page: Page,
  workflowId: string,
  version: number
): Promise<{ requested: Promise<void>; release: () => Promise<void> }> {
  let markRequested = (): void => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let letThrough = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    letThrough = resolve;
  });
  await page.route(
    (url) =>
      url.pathname === `/api/workflows/${workflowId}` &&
      url.searchParams.get("version") === String(version),
    async (route) => {
      markRequested();
      await released;
      await route.continue();
    }
  );
  const release = async (): Promise<void> => {
    const finished = page.waitForEvent("requestfinished", (request) =>
      isVersionRequest(request, workflowId, version)
    );
    letThrough();
    await finished;
  };
  return { requested, release };
}

async function openWorkflow(
  page: Page,
  workflowId: string,
  query = ""
): Promise<void> {
  await page.goto(`/workflows/${workflowId}${query}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCanvas(page);
}

function tab(page: Page, name: "Properties" | "Runs" | "History") {
  return page.getByRole("tab", { name, exact: true });
}

test.describe("Leaving the History tab", () => {
  test("drops a version preview opened by link", async ({ page }) => {
    const id = await createVersionedWorkflow(page);
    try {
      const actionNode = page.getByTestId("action-node-action-1");
      await openWorkflow(page, id, "?version=1");
      await expect(actionNode).toContainText(OLD_LABEL);
      await expect(
        page.getByRole("button", { name: "Exit preview" })
      ).toBeVisible();

      await tab(page, "Runs").click();

      await expect(actionNode).toContainText(LIVE_LABEL);
      await expect(
        page.getByRole("button", { name: "Exit preview" })
      ).toBeHidden();
      await expect(page).not.toHaveURL(VERSION_PARAM);
      await expect(tab(page, "Runs")).toHaveAttribute("aria-selected", "true");
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("clears a ?version=current link", async ({ page }) => {
    const id = await createVersionedWorkflow(page);
    try {
      await openWorkflow(page, id, "?version=current");
      await expect(tab(page, "History")).toHaveAttribute(
        "aria-selected",
        "true"
      );

      await tab(page, "Runs").click();

      await expect(page).not.toHaveURL(VERSION_PARAM);
      // A leftover param would let the deep-link effect pull the panel back.
      await page.waitForTimeout(SETTLE_MS);
      await expect(tab(page, "Runs")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("action-node-action-1")).toContainText(
        LIVE_LABEL
      );
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("cancels a workflow version preview that is still loading", async ({
    page,
  }) => {
    const id = await createVersionedWorkflow(page);
    try {
      await openWorkflow(page, id);
      const held = await holdVersionRequest(page, id, 1);
      await tab(page, "History").click();
      await page.getByRole("button", { name: /Version 1\b/ }).click();
      await page.getByRole("button", { name: "View on canvas" }).click();
      await held.requested;

      await tab(page, "Runs").click();
      await expect(page).not.toHaveURL(VERSION_PARAM);
      await held.release();
      await page.waitForTimeout(SETTLE_MS);

      await expect(tab(page, "Runs")).toHaveAttribute("aria-selected", "true");
      await expect(page).not.toHaveURL(VERSION_PARAM);
      await expect(page.getByTestId("action-node-action-1")).toContainText(
        LIVE_LABEL
      );
      await expect(
        page.getByRole("button", { name: "Exit preview" })
      ).toBeHidden();
    } finally {
      await deleteTestWorkflow(id);
    }
  });

  test("cancels a node version preview that is still loading", async ({
    page,
  }) => {
    const id = await createVersionedWorkflow(page);
    try {
      await openWorkflow(page, id);
      const actionNode = page.getByTestId("action-node-action-1");
      await actionNode.click();
      await expect(page.getByTestId("properties-panel")).toBeVisible();
      const held = await holdVersionRequest(page, id, 1);
      await tab(page, "History").click();
      await page.getByRole("button", { name: /Version 1\b/ }).click();
      await page.getByRole("button", { name: "View on canvas" }).click();
      await held.requested;

      // Double-clicking the node opens Properties, which leaves History.
      await actionNode.dblclick();
      await expect(tab(page, "Properties")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await held.release();
      await page.waitForTimeout(SETTLE_MS);

      await expect(page.locator("#label")).toHaveValue(LIVE_LABEL);
      await expect(actionNode).toContainText(LIVE_LABEL);
      await expect(
        page.getByRole("button", { name: "Exit preview" })
      ).toBeHidden();
    } finally {
      await deleteTestWorkflow(id);
    }
  });
});
