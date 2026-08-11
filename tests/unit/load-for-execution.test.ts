import { beforeEach, describe, expect, it, vi } from "vitest";

let mockDbRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockDbRows),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "workflows.id",
    organizationId: "workflows.organizationId",
  },
  organization: {
    id: "organization.id",
    deactivatedAt: "organization.deactivatedAt",
    name: "organization.name",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

const mockGetWorkflowExecutability = vi.fn();
vi.mock("@/lib/workflow/executable", () => ({
  getWorkflowExecutability: (...args: unknown[]) =>
    mockGetWorkflowExecutability(...args),
}));

import { loadWorkflowForExecution } from "@/lib/workflow/load-for-execution";

const WORKFLOW = {
  id: "wf-1",
  enabled: true,
  deletedAt: null,
  deactivatedAt: null,
  organizationId: "org-1",
  userId: "user-1",
  name: "Test Workflow",
  nodes: [],
  edges: [],
  chain: null,
};

beforeEach(() => {
  mockDbRows = [];
  vi.clearAllMocks();
});

describe("loadWorkflowForExecution", () => {
  it("returns not_found when db returns no row", async () => {
    mockDbRows = [];
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when row has no workflow (null left-join result)", async () => {
    mockDbRows = [
      { workflow: null, orgDeactivatedAt: null, organizationName: null },
    ];
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns ok with workflow and organizationName when executable", async () => {
    mockDbRows = [
      {
        workflow: WORKFLOW,
        orgDeactivatedAt: null,
        organizationName: "Test Org",
      },
    ];
    mockGetWorkflowExecutability.mockReturnValue({ executable: true });
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({
      status: "ok",
      workflow: WORKFLOW,
      organizationName: "Test Org",
    });
  });

  it("returns ok with undefined organizationName when org name is null", async () => {
    mockDbRows = [
      { workflow: WORKFLOW, orgDeactivatedAt: null, organizationName: null },
    ];
    mockGetWorkflowExecutability.mockReturnValue({ executable: true });
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({
      status: "ok",
      workflow: WORKFLOW,
      organizationName: undefined,
    });
  });

  it("returns not_executable with reason deleted", async () => {
    mockDbRows = [
      { workflow: WORKFLOW, orgDeactivatedAt: null, organizationName: null },
    ];
    mockGetWorkflowExecutability.mockReturnValue({
      executable: false,
      reason: "deleted",
    });
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({ status: "not_executable", reason: "deleted" });
  });

  it("returns not_executable with reason deactivated", async () => {
    mockDbRows = [
      { workflow: WORKFLOW, orgDeactivatedAt: null, organizationName: null },
    ];
    mockGetWorkflowExecutability.mockReturnValue({
      executable: false,
      reason: "deactivated",
    });
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({ status: "not_executable", reason: "deactivated" });
  });

  it("returns not_executable with reason org_deactivated", async () => {
    mockDbRows = [
      {
        workflow: WORKFLOW,
        orgDeactivatedAt: new Date(),
        organizationName: null,
      },
    ];
    mockGetWorkflowExecutability.mockReturnValue({
      executable: false,
      reason: "org_deactivated",
    });
    const result = await loadWorkflowForExecution("wf-1", {
      requireEnabled: true,
    });
    expect(result).toEqual({
      status: "not_executable",
      reason: "org_deactivated",
    });
  });

  describe("disabled workflow", () => {
    beforeEach(() => {
      mockDbRows = [
        { workflow: WORKFLOW, orgDeactivatedAt: null, organizationName: "Org" },
      ];
      mockGetWorkflowExecutability.mockReturnValue({
        executable: false,
        reason: "disabled",
      });
    });

    it("returns not_executable when requireEnabled is true (automated trigger)", async () => {
      const result = await loadWorkflowForExecution("wf-1", {
        requireEnabled: true,
      });
      expect(result).toEqual({ status: "not_executable", reason: "disabled" });
    });

    it("returns ok when requireEnabled is false (interactive editor run)", async () => {
      const result = await loadWorkflowForExecution("wf-1", {
        requireEnabled: false,
      });
      expect(result).toEqual({
        status: "ok",
        workflow: WORKFLOW,
        organizationName: "Org",
      });
    });
  });

  it("passes orgDeactivatedAt from the left-join row to getWorkflowExecutability", async () => {
    const orgDeactivatedAt = new Date("2025-01-01");
    mockDbRows = [
      { workflow: WORKFLOW, orgDeactivatedAt, organizationName: null },
    ];
    mockGetWorkflowExecutability.mockReturnValue({ executable: true });
    await loadWorkflowForExecution("wf-1", { requireEnabled: true });
    expect(mockGetWorkflowExecutability).toHaveBeenCalledWith(
      expect.objectContaining({ orgDeactivatedAt })
    );
  });

  it("coerces null orgDeactivatedAt to null in the executability call", async () => {
    mockDbRows = [
      { workflow: WORKFLOW, orgDeactivatedAt: null, organizationName: null },
    ];
    mockGetWorkflowExecutability.mockReturnValue({ executable: true });
    await loadWorkflowForExecution("wf-1", { requireEnabled: true });
    expect(mockGetWorkflowExecutability).toHaveBeenCalledWith(
      expect.objectContaining({ orgDeactivatedAt: null })
    );
  });
});
