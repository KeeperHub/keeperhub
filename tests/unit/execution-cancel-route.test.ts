import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockFindFirst,
  mockGetDualAuthContext,
  mockGetWorkflowAccess,
  mockSet,
  mockWhere,
} = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  return {
    mockFindFirst: vi.fn(),
    mockGetDualAuthContext: vi.fn(),
    mockGetWorkflowAccess: vi.fn(),
    mockSet: set,
    mockWhere: where,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: { workflowExecutions: { findFirst: mockFindFirst } },
    update: () => ({ set: mockSet }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id" },
  workflowExecutionLogs: { executionId: "execution_id", status: "status" },
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: mockGetWorkflowAccess,
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

const ROUTE = "@/app/api/executions/[executionId]/cancel/route";

function makeRequest(): Request {
  return new Request("https://app.keeperhub.com/api/executions/exec-1/cancel", {
    method: "POST",
  });
}

function makeContext(executionId: string) {
  return { params: Promise.resolve({ executionId }) };
}

describe("POST cancel-execution route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "api-key",
      apiKeyId: "key-1",
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      isDeleted: false,
    });
    mockFindFirst.mockResolvedValue({
      id: "exec-1",
      status: "running",
      startedAt: new Date(Date.now() - 1000),
      workflow: { id: "wf-1", organizationId: "org-1" },
    });
  });

  // The route previously resolved auth from the session only, so an org API
  // key could start and poll an execution but never stop one.
  it("lets an api-key caller cancel a running execution", async () => {
    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" })
    );
  });

  it("rejects a caller without full access to the workflow", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: false,
      isDeleted: false,
    });

    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(404);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("hides executions belonging to a soft-deleted workflow", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      isDeleted: true,
    });

    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(404);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("refuses an OAuth token that lacks the write scope", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "oauth",
      apiKeyId: null,
      scope: "mcp:read",
      isAnonymous: false,
    });

    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("propagates the auth error when the caller is unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("refuses to cancel an execution that is not running", async () => {
    mockFindFirst.mockResolvedValue({
      id: "exec-1",
      status: "success",
      startedAt: new Date(),
      workflow: { id: "wf-1", organizationId: "org-1" },
    });

    const { POST } = await import(ROUTE);
    const response = await POST(makeRequest(), makeContext("exec-1"));

    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("marks in-flight step logs cancelled alongside the execution", async () => {
    const { POST } = await import(ROUTE);
    await POST(makeRequest(), makeContext("exec-1"));

    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });
});
