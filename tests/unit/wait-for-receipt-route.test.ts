import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockFindFirst,
  mockGetDualAuthContext,
  mockGetWorkflowAccess,
  mockWaitForExecutionReceipt,
  mockRecordStatusPollMetrics,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockGetDualAuthContext: vi.fn(),
  mockGetWorkflowAccess: vi.fn(),
  mockWaitForExecutionReceipt: vi.fn(),
  mockRecordStatusPollMetrics: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { workflowExecutions: { findFirst: mockFindFirst } } },
}));
vi.mock("@/lib/db/schema", () => ({ workflowExecutions: { id: "id" } }));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: mockGetWorkflowAccess,
}));
vi.mock("@/lib/payments/x402/execution-wait", () => ({
  DEFAULT_CALL_WAIT_TIMEOUT_MS: 25_000,
  waitForExecutionReceipt: mockWaitForExecutionReceipt,
}));
vi.mock("@/lib/metrics", () => ({ createTimer: () => () => 0 }));
vi.mock("@/lib/metrics/instrumentation/api", () => ({
  recordStatusPollMetrics: mockRecordStatusPollMetrics,
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

const ROUTE = "@/app/api/workflows/executions/[executionId]/wait/route";

function makeRequest(timeoutMs?: number): Request {
  const qs = timeoutMs === undefined ? "" : `?timeoutMs=${timeoutMs}`;
  return new Request(`https://app.keeperhub.com/api/wait${qs}`);
}

function makeContext(executionId: string) {
  return { params: Promise.resolve({ executionId }) };
}

describe("GET wait-for-receipt route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: null,
      authMethod: "api-key",
    });
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: true,
      isDeleted: false,
    });
    mockFindFirst.mockResolvedValue({ id: "exec-1", workflow: { id: "wf-1" } });
  });

  it("returns the receipt with transactionHashes when terminal", async () => {
    mockWaitForExecutionReceipt.mockResolvedValue({
      row: {
        status: "success",
        output: { ok: true },
        error: null,
        transactionHashes: [{ hash: "0xabc", nodeId: "n1", nodeName: "Send" }],
        gasUsedWei: "21000",
        completedAt: new Date("2026-06-05T12:00:00.000Z"),
      },
      completed: true,
    });

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(30_000), makeContext("exec-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.completed).toBe(true);
    expect(body.status).toBe("success");
    expect(body.transactionHashes).toEqual([
      { hash: "0xabc", nodeId: "n1", nodeName: "Send" },
    ]);
  });

  it("returns completed=false with current status on timeout", async () => {
    mockWaitForExecutionReceipt.mockResolvedValue({
      row: {
        status: "running",
        output: null,
        error: null,
        transactionHashes: [],
        gasUsedWei: null,
        completedAt: null,
      },
      completed: false,
    });

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(), makeContext("exec-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.completed).toBe(false);
    expect(body.status).toBe("running");
    expect(body.transactionHashes).toEqual([]);
  });

  it("returns 404 when the execution does not exist", async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(), makeContext("missing"));

    expect(res.status).toBe(404);
    expect(mockWaitForExecutionReceipt).not.toHaveBeenCalled();
  });

  it("returns 404 when the execution is deleted mid-wait", async () => {
    mockWaitForExecutionReceipt.mockResolvedValue({
      row: null,
      completed: false,
    });

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(), makeContext("exec-1"));

    expect(res.status).toBe(404);
  });

  it("returns 404 when the caller lacks access", async () => {
    mockGetWorkflowAccess.mockResolvedValue({
      hasFullAccess: false,
      isDeleted: false,
    });

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(), makeContext("exec-1"));

    expect(res.status).toBe(404);
    expect(mockWaitForExecutionReceipt).not.toHaveBeenCalled();
  });

  it("propagates the auth error status", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const { GET } = await import(ROUTE);
    const res = await GET(makeRequest(), makeContext("exec-1"));

    expect(res.status).toBe(401);
  });

  it("clamps timeoutMs above the max before waiting", async () => {
    mockWaitForExecutionReceipt.mockResolvedValue({
      row: {
        status: "running",
        output: null,
        error: null,
        transactionHashes: [],
        gasUsedWei: null,
        completedAt: null,
      },
      completed: false,
    });

    const { GET } = await import(ROUTE);
    await GET(makeRequest(999_999), makeContext("exec-1"));

    expect(mockWaitForExecutionReceipt).toHaveBeenCalledWith("exec-1", 60_000);
  });
});
