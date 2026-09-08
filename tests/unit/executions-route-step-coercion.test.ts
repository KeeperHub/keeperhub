import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();
const findFirstMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: findFirstMock },
      workflowExecutions: { findMany: findManyMock },
    },
  },
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "user_1",
    organizationId: null,
    authMethod: "session",
  }),
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi
    .fn()
    .mockResolvedValue({ hasFullAccess: true, isDeleted: false }),
}));

describe("KEEP-481: executions list coerces step counts to number|null", () => {
  it("returns totalSteps and completedSteps as numbers when set", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "wf_1", userId: "user_1" });
    findManyMock.mockResolvedValueOnce([
      {
        id: "exec_1",
        workflowId: "wf_1",
        userId: "user_1",
        status: "success",
        totalSteps: "4",
        completedSteps: "4",
      },
    ]);

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await GET(new Request("http://test/executions"), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });
    const body = (await response.json()) as Array<{
      totalSteps: unknown;
      completedSteps: unknown;
    }>;

    expect(body[0].totalSteps).toBe(4);
    expect(body[0].completedSteps).toBe(4);
  });

  it("returns null when totalSteps is null in the database row", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "wf_1", userId: "user_1" });
    findManyMock.mockResolvedValueOnce([
      {
        id: "exec_1",
        workflowId: "wf_1",
        userId: "user_1",
        status: "running",
        totalSteps: null,
        completedSteps: "0",
      },
    ]);

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await GET(new Request("http://test/executions"), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });
    const body = (await response.json()) as Array<{
      totalSteps: unknown;
      completedSteps: unknown;
    }>;

    expect(body[0].totalSteps).toBeNull();
    expect(body[0].completedSteps).toBe(0);
  });

  it("returns null for non-numeric strings rather than NaN", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "wf_1", userId: "user_1" });
    findManyMock.mockResolvedValueOnce([
      {
        id: "exec_1",
        workflowId: "wf_1",
        userId: "user_1",
        status: "error",
        totalSteps: "garbage",
        completedSteps: "also-bad",
      },
    ]);

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await GET(new Request("http://test/executions"), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });
    const body = (await response.json()) as Array<{
      totalSteps: unknown;
      completedSteps: unknown;
    }>;

    expect(body[0].totalSteps).toBeNull();
    expect(body[0].completedSteps).toBeNull();
  });
});
