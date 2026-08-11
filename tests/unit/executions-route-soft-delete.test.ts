import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findFirstMock = vi.fn();
const findManyMock = vi.fn();
const deleteWhereMock = vi.fn();
const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));
const updateWhereMock = vi.fn();
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: findFirstMock },
      workflowExecutions: { findMany: findManyMock },
    },
    delete: deleteMock,
    update: updateMock,
  },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "user_1",
    organizationId: "org_1",
    authMethod: "session",
    scope: undefined,
    apiKeyId: null,
  }),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi
    .fn()
    .mockResolvedValue({ hasFullAccess: true, isDeleted: false }),
}));

import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

beforeEach(() => {
  vi.clearAllMocks();
  deleteWhereMock.mockResolvedValue(undefined);
  updateWhereMock.mockResolvedValue(undefined);
});

// Purging execution history must not reduce the billable count, so runs are
// soft-deleted (deleted_at) rather than hard-deleted; only the bulky per-step
// logs are hard-deleted to reclaim storage.
describe("executions DELETE route soft-deletes runs", () => {
  it("soft-deletes the runs and hard-deletes only their logs", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "wf_1",
      userId: "user_1",
      organizationId: "org_1",
    });
    findManyMock.mockResolvedValueOnce([{ id: "exec_1" }, { id: "exec_2" }]);

    const { DELETE } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await DELETE(
      new Request("http://test/executions", { method: "DELETE" }),
      { params: Promise.resolve({ workflowId: "wf_1" }) }
    );
    const body = (await response.json()) as { deletedCount: number };

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(2);

    // Runs are soft-deleted (deleted_at stamped), never hard-deleted.
    expect(updateMock).toHaveBeenCalledWith(workflowExecutions);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) })
    );
    expect(deleteMock).not.toHaveBeenCalledWith(workflowExecutions);

    // Only the per-step logs are hard-deleted.
    expect(deleteMock).toHaveBeenCalledWith(workflowExecutionLogs);
  });

  it("does not touch executions when there are none", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "wf_1",
      userId: "user_1",
      organizationId: "org_1",
    });
    findManyMock.mockResolvedValueOnce([]);

    const { DELETE } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await DELETE(
      new Request("http://test/executions", { method: "DELETE" }),
      { params: Promise.resolve({ workflowId: "wf_1" }) }
    );
    const body = (await response.json()) as { deletedCount: number };

    expect(body.deletedCount).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
