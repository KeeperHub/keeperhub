import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { getDbConnection } from "./utils/connection";
import {
  addTestOrganization,
  createTestWorkflow,
  deleteTestWorkflow,
  getUserIdByEmail,
  PERSISTENT_BYSTANDER_EMAIL,
  PERSISTENT_TEST_USER_EMAIL,
  removeTestOrganization,
} from "./utils/db";
import { waitForCanvas } from "./utils/workflow";

// The default test user joins an org owned by someone else as a viewer, with
// one workflow in it, and acts in that org for the duration of the suite.
test.describe("viewer role", () => {
  test.describe.configure({ mode: "serial" });

  let orgId: string;
  let workflowId: string;

  test.beforeAll(async () => {
    orgId = await addTestOrganization(
      PERSISTENT_BYSTANDER_EMAIL,
      "Viewer E2E Org"
    );
    const workflow = await createTestWorkflow(PERSISTENT_BYSTANDER_EMAIL, {
      name: "Viewer E2E Workflow",
    });
    workflowId = workflow.id;

    const viewerId = await getUserIdByEmail(PERSISTENT_TEST_USER_EMAIL);
    const sql = getDbConnection();
    try {
      await sql`UPDATE workflows SET organization_id = ${orgId} WHERE id = ${workflowId}`;
      await sql`
        INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES (${randomUUID()}, ${orgId}, ${viewerId}, 'viewer', ${new Date()})
      `;
    } finally {
      await sql.end();
    }
  });

  test.afterAll(async () => {
    await deleteTestWorkflow(workflowId);
    await removeTestOrganization(orgId);
  });

  test.beforeEach(async ({ apiRequest }) => {
    const res = await apiRequest.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
    });
    expect(res.ok()).toBe(true);
  });

  test("reads a workflow but gets the editor in read-only mode", async ({
    page,
  }) => {
    const res = await page.request.get(`/api/workflows/${workflowId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isOwner).toBe(false);
    expect(body.canRead).toBe(true);

    await page.goto(`/workflows/${workflowId}`);
    await waitForCanvas(page);

    await expect(page.getByText("Read only", { exact: true })).toBeVisible();
    await expect(page.getByTestId("nav-new")).toHaveCount(0);
  });

  test("is refused on every write", async ({ apiRequest }) => {
    const writes = [
      apiRequest.post("/api/workflows/create", {
        data: { name: "Blocked", nodes: [], edges: [] },
      }),
      apiRequest.patch(`/api/workflows/${workflowId}`, {
        data: { name: "Renamed" },
      }),
      apiRequest.delete(`/api/workflows/${workflowId}`),
      apiRequest.post(`/api/workflow/${workflowId}/execute`, { data: {} }),
      apiRequest.post("/api/projects", { data: { name: "Blocked" } }),
      apiRequest.post("/api/keys", { data: { name: "Blocked" } }),
      // Naming another org in the header does not lift the active-org check.
      apiRequest.post("/api/workflows/current", {
        data: { nodes: [], edges: [] },
        headers: { "X-Organization-Id": "not-a-real-org" },
      }),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.status()).toBe(403);
      expect((await res.json()).code).toBe("viewer_read_only");
    }
  });

  test("keeps the workflow unchanged", async ({ page }) => {
    const res = await page.request.get(`/api/workflows/${workflowId}`);
    expect((await res.json()).name).toBe("Viewer E2E Workflow");
  });
});
